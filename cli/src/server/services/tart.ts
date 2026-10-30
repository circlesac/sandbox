import { execFile, execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import type { SandboxInfo } from "../types.ts";
import { UnsupportedError } from "../errors.ts";
import type {
	ContainerBackend,
	CreateContainerOpts,
	ProxyTarget,
} from "./backend.ts";
import type { SandboxLifecycle } from "./lifecycle.ts";

/**
 * What the server must remember about a sandbox to find its VM again after a
 * restart. Kept in the state file; the proxy, its port, and the VM's address
 * belong to one server process and are rebuilt when needed.
 */
interface TartStoredInstance {
	sandboxId: string;
	vmName: string;
	accessToken: string;
	templateId: string;
	createdAt: string;
	/** Where the current timeout counts from: creation, or the last extension. */
	timeoutFrom: string;
	timeoutSec: number;
	metadata?: Record<string, string>;
	lifecycle: SandboxLifecycle;
	/** Paused by this server, so a stopped VM is not a finished runner. */
	paused?: boolean;
}

interface TartInstance extends TartStoredInstance {
	hostPort: number;
	vmIp?: string;
	proxy?: ReturnType<typeof createServer>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === "string")
	);
}

function isLifecycle(value: unknown): value is SandboxLifecycle {
	if (!value || typeof value !== "object") return false;
	const l = value as Record<string, unknown>;
	return (
		typeof l.autoPause === "boolean" &&
		typeof l.keepMemory === "boolean" &&
		typeof l.autoResume === "boolean" &&
		typeof l.secure === "boolean" &&
		(l.trafficAccessToken === null || typeof l.trafficAccessToken === "string")
	);
}

function isDate(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Reads one state file entry, or nothing when it is not an instance. */
function parseStoredInstance(value: unknown): TartStoredInstance | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (
		typeof v.sandboxId !== "string" ||
		typeof v.vmName !== "string" ||
		typeof v.accessToken !== "string" ||
		typeof v.templateId !== "string" ||
		!isDate(v.createdAt) ||
		!isDate(v.timeoutFrom) ||
		typeof v.timeoutSec !== "number" ||
		!Number.isFinite(v.timeoutSec) ||
		v.timeoutSec <= 0 ||
		(v.metadata !== undefined && !isStringRecord(v.metadata)) ||
		!isLifecycle(v.lifecycle) ||
		(v.paused !== undefined && typeof v.paused !== "boolean")
	) {
		return undefined;
	}
	return {
		sandboxId: v.sandboxId,
		vmName: v.vmName,
		accessToken: v.accessToken,
		templateId: v.templateId,
		createdAt: v.createdAt,
		timeoutFrom: v.timeoutFrom,
		timeoutSec: v.timeoutSec,
		metadata: v.metadata,
		lifecycle: v.lifecycle,
		paused: v.paused,
	};
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
		// No shell: a VM name from `tart list` is passed as one argument.
		execFile(
			"tart",
			args,
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
	private statePath: string | null;
	/** Pauses under way; outside them a running VM is not paused, whatever the state file says. */
	private pausing = new Set<string>();
	/** Resumes under way: the VM already runs while the sandbox is still paused. */
	private resuming = new Set<string>();
	/** Stored running VMs whose proxy is being rebuilt, so it is built once. */
	private attaching = new Map<string, Promise<void>>();

	constructor(opts: { statePath?: string | null } = {}) {
		this.statePath =
			opts.statePath === undefined
				? join(config.stateDir, "tart-instances.json")
				: opts.statePath;
		this.loadState();
	}

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
		this.persistState();

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
			this.persistState();
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
				const res = await fetch(`http://${vmIp}:${config.envdPort}/health`, {
					signal: AbortSignal.timeout(2_000),
				});
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
			this.persistState();
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

		// Forward envd through a local port (the instance was registered early
		// to prevent orphan cleanup)
		await this.attachProxy(instance, vmIp);

		return { instanceId: vmName, hostPort: instance.hostPort };
	}

	/** Forwards localhost:<hostPort> to the VM's envd port, replacing any earlier proxy. */
	private async attachProxy(
		instance: TartInstance,
		vmIp: string,
	): Promise<void> {
		instance.proxy?.close();
		const hostPort = await findFreePort();
		instance.proxy = createTcpProxy(hostPort, vmIp, config.envdPort);
		instance.hostPort = hostPort;
		instance.vmIp = vmIp;
	}

	/**
	 * A running VM read from the state file has no proxy: the server that
	 * built it is gone. Find the VM's address and forward envd again, once,
	 * when the sandbox is first used. A paused VM waits for startContainer,
	 * which rebuilds the proxy as it resumes.
	 */
	/** A VM that stopped while not paused or being created: its runner finished. */
	private finishedOnItsOwn(instance: TartInstance, vmState: string): boolean {
		return (
			vmState === "stopped" &&
			!instance.paused &&
			!this.starting.has(instance.vmName) &&
			!this.resuming.has(instance.sandboxId)
		);
	}

	/** Deletes a finished VM; the caller drops it from the state, now or in a batch. */
	private async cleanUpFinished(
		sandboxId: string,
		instance: TartInstance,
		forget = true,
	): Promise<void> {
		console.log(
			`VM "${instance.vmName}" stopped (runner finished), cleaning up`,
		);
		try {
			await tartExec(["delete", instance.vmName]);
		} catch {}
		instance.proxy?.close();
		if (forget) this.instances.delete(sandboxId);
	}

	/**
	 * A running VM marked paused with no pause under way was being paused
	 * when a previous server stopped: the suspend never happened. Treat it as
	 * running again, or it would get no envd forwarding until it expired.
	 */
	private clearStalePause(instance: TartInstance): void {
		if (
			!instance.paused ||
			this.pausing.has(instance.sandboxId) ||
			this.resuming.has(instance.sandboxId)
		) {
			return;
		}
		instance.paused = false;
		this.persistState();
	}

	private async attachLoaded(instance: TartInstance): Promise<void> {
		if (instance.proxy || instance.paused) return;
		let pending = this.attaching.get(instance.sandboxId);
		if (!pending) {
			pending = (async () => {
				const vmIp = await tartIp(instance.vmName, 3);
				// Removed while the address was looked up: nothing to forward to.
				if (!vmIp || this.instances.get(instance.sandboxId) !== instance)
					return;
				await this.attachProxy(instance, vmIp);
			})()
				.catch(() => {})
				.finally(() => this.attaching.delete(instance.sandboxId));
			this.attaching.set(instance.sandboxId, pending);
		}
		await pending;
	}

	async startContainer(sandboxId: string): Promise<{ hostPort: number }> {
		const instance = this.instances.get(sandboxId);
		if (!instance) {
			throw new Error(`Sandbox "${sandboxId}" not found`);
		}
		// While it resumes, the VM runs but the sandbox is still paused; the
		// stale-pause and finished-runner checks must not act on it.
		this.resuming.add(sandboxId);
		try {
			return await this.resumeVm(instance);
		} catch (err) {
			// A resume that failed leaves the sandbox paused. A VM it started is
			// stopped again (keeping its disk), so nothing runs that no one can
			// use; a VM that never left suspension is left as it is.
			const state = (await tartList()).find(
				(v) => v.name === instance.vmName,
			)?.state;
			if (state === "running") {
				await tartExec(["stop", instance.vmName]).catch(() => {});
			}
			instance.proxy?.close();
			instance.proxy = undefined;
			instance.paused = true;
			this.persistState();
			throw err;
		} finally {
			this.resuming.delete(sandboxId);
		}
	}

	private async resumeVm(
		instance: TartInstance,
	): Promise<{ hostPort: number }> {
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
		// A suspended VM gets enough rounds for its tart run restarts too.
		for (let i = 0; i < (coldBoot ? 18 : 6); i++) {
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

		// Wait for envd-lite to become healthy, on a time budget rather than a
		// count of rounds, since a refused connection returns at once.
		const healthDeadline = Date.now() + (coldBoot ? 120_000 : 30_000);
		let healthy = false;
		while (!healthy && Date.now() < healthDeadline) {
			try {
				const res = await fetch(`http://${vmIp}:${config.envdPort}/health`, {
					signal: AbortSignal.timeout(2_000),
				});
				healthy = res.status === 204;
			} catch {
				// not ready yet
			}
			if (!healthy) {
				await new Promise((r) => setTimeout(r, coldBoot ? 2000 : 200));
			}
		}
		// A resume that cannot reach envd is a failed resume, not a running
		// sandbox nobody can use.
		if (!healthy) {
			throw new Error(
				`envd-lite in VM "${instance.vmName}" did not become healthy after resume`,
			);
		}

		// Recreate TCP proxy (previous one was closed on pause)
		await this.attachProxy(instance, vmIp);
		instance.paused = false;
		this.persistState();

		return { hostPort: instance.hostPort };
	}

	/** envd goes through the local TCP proxy; other ports go to the VM's address. */
	async resolveTarget(
		sandboxId: string,
		port: number,
	): Promise<ProxyTarget | null> {
		const instance = this.instances.get(sandboxId);
		if (!instance) return null;
		await this.attachLoaded(instance);
		if (!instance.vmIp || !instance.hostPort) return null;
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
		this.persistState();
	}

	async stopContainer(
		sandboxId: string,
		opts: { keepMemory?: boolean } = {},
	): Promise<boolean> {
		this.pausing.add(sandboxId);
		try {
			return await this.suspendVm(sandboxId, opts);
		} finally {
			this.pausing.delete(sandboxId);
		}
	}

	private async suspendVm(
		sandboxId: string,
		opts: { keepMemory?: boolean },
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
		this.persistState();

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
		// Still running: the pause did not happen, so do not report a paused
		// sandbox whose VM keeps running with no timeout.
		instance.paused = false;
		this.persistState();
		throw new Error(`Tart VM "${instance.vmName}" did not suspend or stop`);
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
		this.persistState();
		return true;
	}

	async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
		const instance = this.instances.get(sandboxId);
		if (!instance) return null;

		const vms = await tartList();
		const vm = vms.find((v) => v.name === instance.vmName);

		if (!vm) {
			this.instances.delete(sandboxId);
			this.persistState();
			return null;
		}
		// Stopped without a pause: the runner finished. Gone, as listSandboxes
		// reports it, not a paused sandbox that could be resumed.
		if (this.finishedOnItsOwn(instance, vm.state)) {
			await this.cleanUpFinished(sandboxId, instance);
			this.persistState();
			return null;
		}

		const state: "running" | "paused" =
			vm.state === "running" ? "running" : "paused";
		if (state === "running") {
			this.clearStalePause(instance);
			await this.attachLoaded(instance);
		}

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
			if (this.finishedOnItsOwn(instance, vm.state)) {
				await this.cleanUpFinished(id, instance, false);
				dead.push(id);
				continue;
			}

			const state: "running" | "paused" =
				vm.state === "running" ? "running" : "paused";
			if (state === "running") this.clearStalePause(instance);

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
		if (dead.length > 0) this.persistState();

		// Clean orphaned VMs: in neither the instance map (which includes the
		// sandboxes read from the state file) nor the starting set.
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

	/**
	 * Reads the sandboxes a previous server process left behind. Their VMs
	 * are not checked here: the first listSandboxes drops any whose VM is
	 * gone, and attachLoaded or startContainer reaches the rest when used.
	 */
	private loadState(): void {
		if (!this.statePath || !existsSync(this.statePath)) return;
		try {
			const stored = JSON.parse(readFileSync(this.statePath, "utf8"));
			if (!stored || typeof stored !== "object" || Array.isArray(stored))
				return;
			for (const value of Object.values(stored)) {
				const instance = parseStoredInstance(value);
				if (!instance) continue;
				this.instances.set(instance.sandboxId, { ...instance, hostPort: 0 });
			}
		} catch (err) {
			console.warn(
				`Failed to read Tart state: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private persistState(): void {
		if (!this.statePath) return;
		const stored: Record<string, TartStoredInstance> = {};
		for (const [id, instance] of this.instances) {
			stored[id] = {
				sandboxId: instance.sandboxId,
				vmName: instance.vmName,
				accessToken: instance.accessToken,
				templateId: instance.templateId,
				createdAt: instance.createdAt,
				timeoutFrom: instance.timeoutFrom,
				timeoutSec: instance.timeoutSec,
				metadata: instance.metadata,
				lifecycle: instance.lifecycle,
				paused: instance.paused,
			};
		}
		mkdirSync(dirname(this.statePath), { recursive: true });
		const tempPath = `${this.statePath}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(stored, null, 2)}\n`);
		renameSync(tempPath, this.statePath);
	}
}
