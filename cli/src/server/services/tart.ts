import { exec, execSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { connect } from "node:net";
import { config } from "../config.ts";
import type { SandboxInfo } from "../types.ts";
import { UnsupportedError } from "../errors.ts";
import type {
	ContainerBackend,
	CreateContainerOpts,
	ProxyTarget,
} from "./backend.ts";
import type { SandboxLifecycle } from "./lifecycle.ts";

interface TartInstance {
	sandboxId: string;
	vmName: string;
	hostPort: number;
	accessToken: string;
	templateId: string;
	createdAt: string;
	/** Where the current timeout counts from: creation, or the last extension. */
	timeoutFrom: string;
	timeoutSec: number;
	metadata?: Record<string, string>;
	lifecycle: SandboxLifecycle;
	vmIp?: string;
	/** Paused by this server, so a stopped VM is not a finished runner. */
	paused?: boolean;
	proxy?: ReturnType<typeof createServer>;
}

interface TartVm {
	name: string;
	state: string;
	// tart list --format json provides more fields but we only need these
}

/**
 * Runs the tart CLI without blocking the server: `tart ip --wait`, suspend,
 * and clone can each take up to a minute or two, and a synchronous call would
 * stall every other request meanwhile. Output and errors are captured.
 */
function tartExec(args: string[], timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(
			`tart ${args.join(" ")}`,
			{ encoding: "utf-8", timeout: timeoutMs },
			(err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
		);
	});
}

async function tartList(): Promise<TartVm[]> {
	try {
		const output = await tartExec(["list", "--format", "json"]);
		if (!output) return [];
		const parsed = JSON.parse(output);
		// tart list --format json returns an array of objects with Source, Name, Size, State, etc.
		if (Array.isArray(parsed)) {
			return parsed.map((vm: Record<string, string>) => ({
				name: vm.Name ?? vm.name ?? "",
				state: (vm.State ?? vm.state ?? "").toLowerCase(),
			}));
		}
		return [];
	} catch {
		return [];
	}
}

function tartIp(vmName: string, waitSec = 30): Promise<string> {
	return tartExec(
		["ip", "--wait", String(waitSec), vmName],
		(waitSec + 10) * 1000,
	);
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close();
				return reject(new Error("Failed to get port"));
			}
			const { port } = addr;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** Create a TCP proxy forwarding localhost:localPort → vmIp:remotePort */
function createTcpProxy(
	localPort: number,
	remoteHost: string,
	remotePort: number,
): ReturnType<typeof createServer> {
	const server = createServer((clientSocket: Socket) => {
		const upstream = connect(remotePort, remoteHost);
		clientSocket.pipe(upstream);
		upstream.pipe(clientSocket);
		clientSocket.on("error", () => upstream.destroy());
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("close", () => upstream.destroy());
		upstream.on("close", () => clientSocket.destroy());
	});
	server.listen(localPort);
	return server;
}

export class TartBackend implements ContainerBackend {
	readonly type = "tart" as const;
	readonly supportsPause = true;
	// A stopped tart VM counts as finished and is deleted, so a pause always
	// suspends and keeps memory.
	readonly supportsFilesystemPause = false;
	readonly envdChecksAccessToken = false;
	// envd-lite enforces a token it is given; older base images ignore it, so
	// the control plane keeps checking as well.
	readonly envdAcceptsAccessToken = true;
	private instances = new Map<string, TartInstance>();
	/**
	 * VMs being cloned and booted. Until they run they list as stopped, and
	 * the cleanup in listSandboxes must not mistake them for finished or
	 * orphaned VMs (tart commands are async, so a list can run meanwhile).
	 */
	private starting = new Set<string>();

	static isAvailable(): boolean {
		try {
			execSync("tart --version", { stdio: "ignore", timeout: 5_000 });
			return true;
		} catch {
			return false;
		}
	}

	private async vmIsSuspended(vmName: string): Promise<boolean> {
		const vms = await tartList();
		const vm = vms.find((v) => v.name === vmName);
		return vm?.state === "suspended";
	}

	async resolveImage(templateId: string): Promise<string> {
		const imageName =
			templateId === "base" ? "sandbox-base" : `sandbox-${templateId}`;

		const vms = await tartList();
		if (vms.some((vm) => vm.name === imageName)) {
			return imageName;
		}

		throw new Error(
			`Template "${templateId}" not found. No tart VM "${imageName}" exists.\n` +
				`Create one with: tart clone <source> ${imageName}`,
		);
	}

	async createContainer(
		opts: CreateContainerOpts,
	): Promise<{ instanceId: string; hostPort: number }> {
		const vmName = `sandbox-${opts.sandboxId}`;
		this.starting.add(vmName);
		try {
			return await this.createVm(opts, vmName);
		} finally {
			this.starting.delete(vmName);
		}
	}

	private async createVm(
		opts: CreateContainerOpts,
		vmName: string,
	): Promise<{ instanceId: string; hostPort: number }> {
		const image = await this.resolveImage(opts.templateId);

		// Clone the template VM (APFS COW — instant, ~0.1s)
		await tartExec(["clone", image, vmName], 120_000);

		// Register instance immediately to prevent orphan cleanup from deleting it
		const now = new Date().toISOString();
		const instance: TartInstance = {
			sandboxId: opts.sandboxId,
			vmName,
			hostPort: 0,
			accessToken: opts.accessToken,
			templateId: opts.templateId,
			createdAt: now,
			timeoutFrom: now,
			timeoutSec: opts.timeoutSec,
			metadata: opts.metadata,
			lifecycle: opts.lifecycle,
		};
		this.instances.set(opts.sandboxId, instance);

		// Check if the cloned VM has a suspended state (for fast resume)
		const isSuspended = await this.vmIsSuspended(vmName);

		// Start the VM in the background (resume if suspended, cold boot otherwise)
		const run = Bun.spawn(
			["tart", "run", vmName, "--no-graphics", "--suspendable"],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const runError = new Response(run.stderr).text();

		if (!isSuspended) {
			// Cold boot: wait 10s before polling for IP
			await new Promise((r) => setTimeout(r, 10_000));
		} else {
			// Suspended resume: IP available almost instantly, short delay for VM state restore
			await new Promise((r) => setTimeout(r, 1_000));
		}

		let vmIp: string | undefined;
		const maxRetries = isSuspended ? 2 : 6;
		const ipWaitSec = isSuspended ? 3 : 30;
		for (let i = 0; i < maxRetries; i++) {
			try {
				vmIp = await tartIp(vmName, ipWaitSec);
				if (vmIp) break;
			} catch {
				// VM not ready yet, retry
			}
		}

		if (!vmIp) {
			// Cleanup on failure
			this.instances.delete(opts.sandboxId);
			try {
				await tartExec(["stop", vmName]);
			} catch {}
			try {
				await tartExec(["delete", vmName]);
			} catch {}
			// tart run exits at once when it cannot start the VM, for example
			// "The number of VMs exceeds the system limit" (macOS allows two).
			const reason = run.exitCode !== null ? (await runError).trim() : "";
			throw new Error(
				reason
					? `Tart VM "${vmName}" did not start: ${reason}`
					: `Tart VM "${vmName}" failed to obtain an IP address within 190s`,
			);
		}

		// Wait for envd-lite to become healthy (pre-installed in base image via LaunchAgent)
		let envdReady = false;
		const envdMaxRetries = isSuspended ? 30 : 60;
		const envdPollMs = isSuspended ? 200 : 2000;
		for (let i = 0; i < envdMaxRetries; i++) {
			try {
				const res = await fetch(`http://${vmIp}:${config.envdPort}/health`);
				if (res.status === 204) {
					envdReady = true;
					break;
				}
			} catch {
				// not ready yet
			}
			await new Promise((r) => setTimeout(r, envdPollMs));
		}

		if (!envdReady) {
			this.instances.delete(opts.sandboxId);
			try {
				await tartExec(["stop", vmName]);
			} catch {}
			try {
				await tartExec(["delete", vmName]);
			} catch {}
			throw new Error(
				`envd-lite in VM "${vmName}" did not become healthy within 120s. ` +
					`Ensure envd-lite is pre-installed in the base image.`,
			);
		}

		// Set up a local TCP proxy forwarding to the VM's envd port
		const hostPort = await findFreePort();
		const proxy = createTcpProxy(hostPort, vmIp, config.envdPort);

		// Update instance with runtime info (was registered early to prevent orphan cleanup)
		instance.hostPort = hostPort;
		instance.proxy = proxy;
		instance.vmIp = vmIp;

		return { instanceId: vmName, hostPort };
	}

	async startContainer(sandboxId: string): Promise<{ hostPort: number }> {
		const instance = this.instances.get(sandboxId);
		if (!instance) {
			throw new Error(`Sandbox "${sandboxId}" not found`);
		}

		const vms = await tartList();
		const vm = vms.find((v) => v.name === instance.vmName);
		const wasRunning = vm?.state === "running";

		// Resume a stopped or suspended VM. tart run exits at once when it
		// cannot start one, for example while the previous run of a VM that
		// could not be saved still holds it; try again a few times, then say why.
		let run: ReturnType<typeof Bun.spawn> | undefined;
		let runError = Promise.resolve("");
		let restarts = 0;
		const startRun = () => {
			run = Bun.spawn(
				["tart", "run", instance.vmName, "--no-graphics", "--suspendable"],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			runError = new Response(run.stderr as ReadableStream).text();
		};
		if (!wasRunning) startRun();

		// Get IP (may have changed after resume). Resume from suspended is fast,
		// so use short waits; a stopped VM (a pause the host could not save)
		// boots from disk, polled in short steps so a failed run is noticed.
		const coldBoot = vm?.state === "stopped";
		let vmIp: string | undefined;
		for (let i = 0; i < (coldBoot ? 18 : 2); i++) {
			if (run && run.exitCode !== null) {
				if (restarts >= 3) break;
				restarts++;
				await new Promise((r) => setTimeout(r, 2_000));
				startRun();
			}
			try {
				vmIp = await tartIp(instance.vmName, coldBoot ? 10 : 3);
				if (vmIp) break;
			} catch {}
		}

		if (!vmIp) {
			const reason =
				run && run.exitCode !== null ? (await runError).trim() : "";
			throw new Error(
				reason
					? `Tart VM "${instance.vmName}" did not resume: ${reason}`
					: `VM "${instance.vmName}" failed to get IP on resume`,
			);
		}

		// Wait for envd-lite to become healthy (suspended resume is near-instant)
		for (let i = 0; i < (coldBoot ? 60 : 30); i++) {
			try {
				const res = await fetch(`http://${vmIp}:${config.envdPort}/health`);
				if (res.status === 204) break;
			} catch {
				// not ready yet
			}
			await new Promise((r) => setTimeout(r, coldBoot ? 2000 : 200));
		}

		// Recreate TCP proxy (previous one was closed on pause)
		instance.proxy?.close();
		const hostPort = await findFreePort();
		instance.proxy = createTcpProxy(hostPort, vmIp, config.envdPort);
		instance.hostPort = hostPort;
		instance.vmIp = vmIp;
		instance.paused = false;

		return { hostPort };
	}

	/** envd goes through the local TCP proxy; other ports go to the VM's address. */
	async resolveTarget(
		sandboxId: string,
		port: number,
	): Promise<ProxyTarget | null> {
		const instance = this.instances.get(sandboxId);
		if (!instance?.vmIp || !instance.hostPort) return null;
		if (port === config.envdPort) {
			return { host: "localhost", port: instance.hostPort };
		}
		return { host: instance.vmIp, port };
	}

	refreshTimeout(sandboxId: string, timeoutSec: number): void {
		const instance = this.instances.get(sandboxId);
		if (!instance) return;
		instance.timeoutFrom = new Date().toISOString();
		instance.timeoutSec = timeoutSec;
	}

	async stopContainer(
		sandboxId: string,
		opts: { keepMemory?: boolean } = {},
	): Promise<boolean> {
		const instance = this.instances.get(sandboxId);
		if (!instance) return false;
		if (opts.keepMemory === false) {
			throw new UnsupportedError(
				"The tart backend cannot pause without keeping memory",
			);
		}

		instance.proxy?.close();
		instance.proxy = undefined;
		instance.paused = true;

		try {
			await tartExec(["suspend", instance.vmName], 60_000);
		} catch {
			// fallback to stop if suspend fails
			try {
				await tartExec(["stop", instance.vmName]);
			} catch {}
		}

		// tart suspend returns before the VM is saved. When the save fails (some
		// hosts refuse with "permission denied"), the VM stops instead: its disk
		// survives, its memory and processes do not.
		for (let i = 0; i < 60; i++) {
			const state = (await tartList()).find(
				(v) => v.name === instance.vmName,
			)?.state;
			if (state === "suspended") return true;
			if (state === "stopped") {
				console.warn(
					`Tart could not save VM "${instance.vmName}"; it stopped instead, keeping only its disk`,
				);
				return true;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		return true;
	}

	async removeContainer(sandboxId: string): Promise<boolean> {
		const instance = this.instances.get(sandboxId);
		if (!instance) return false;

		instance.proxy?.close();
		instance.proxy = undefined;

		try {
			await tartExec(["stop", instance.vmName]);
		} catch {}

		try {
			await tartExec(["delete", instance.vmName]);
		} catch {}

		this.instances.delete(sandboxId);
		return true;
	}

	async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
		const instance = this.instances.get(sandboxId);
		if (!instance) return null;

		const vms = await tartList();
		const vm = vms.find((v) => v.name === instance.vmName);

		if (!vm) {
			this.instances.delete(sandboxId);
			return null;
		}

		const state: "running" | "paused" =
			vm.state === "running" ? "running" : "paused";

		return {
			sandboxId: instance.sandboxId,
			instanceId: instance.vmName,
			accessToken: instance.accessToken,
			templateId: instance.templateId,
			startedAt: instance.createdAt,
			timeoutFrom: instance.timeoutFrom,
			timeoutSec: instance.timeoutSec,
			hostPort: instance.hostPort,
			state,
			metadata: instance.metadata,
			lifecycle: instance.lifecycle,
		};
	}

	async listSandboxes(filters?: {
		state?: "running" | "paused";
	}): Promise<SandboxInfo[]> {
		const vms = await tartList();
		const vmMap = new Map(vms.map((vm) => [vm.name, vm]));
		const results: SandboxInfo[] = [];
		const dead: string[] = [];

		for (const [id, instance] of this.instances) {
			const vm = vmMap.get(instance.vmName);
			if (!vm) {
				dead.push(id);
				continue;
			}

			// VM shut itself down (runner finished) → clean up
			if (
				vm.state === "stopped" &&
				!instance.paused &&
				!this.starting.has(instance.vmName)
			) {
				console.log(
					`VM "${instance.vmName}" stopped (runner finished), cleaning up`,
				);
				try {
					await tartExec(["delete", instance.vmName]);
				} catch {}
				instance.proxy?.close();
				dead.push(id);
				continue;
			}

			const state: "running" | "paused" =
				vm.state === "running" ? "running" : "paused";

			if (filters?.state && filters.state !== state) continue;

			results.push({
				sandboxId: instance.sandboxId,
				instanceId: instance.vmName,
				accessToken: instance.accessToken,
				templateId: instance.templateId,
				startedAt: instance.createdAt,
				timeoutFrom: instance.timeoutFrom,
				timeoutSec: instance.timeoutSec,
				hostPort: instance.hostPort,
				state,
				metadata: instance.metadata,
				lifecycle: instance.lifecycle,
			});
		}

		for (const id of dead) {
			this.instances.delete(id);
		}

		// Clean orphaned VMs not in instance map (e.g. from previous process)
		for (const vm of vms) {
			if (
				vm.name.startsWith("sandbox-sbx-") &&
				!this.instances.has(vm.name.replace("sandbox-", "")) &&
				!this.starting.has(vm.name)
			) {
				if (vm.state === "stopped" || vm.state === "suspended") {
					console.log(`Orphaned VM "${vm.name}" (${vm.state}), deleting`);
					try {
						await tartExec(["delete", vm.name]);
					} catch {}
				} else if (vm.state === "running") {
					console.log(`Orphaned VM "${vm.name}" running, stopping + deleting`);
					try {
						await tartExec(["stop", vm.name]);
					} catch {}
					try {
						await tartExec(["delete", vm.name]);
					} catch {}
				}
			}
		}

		return results;
	}
}
