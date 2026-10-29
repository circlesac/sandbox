import Docker from "dockerode";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { NotFoundError, RetryableError } from "../errors.ts";
import type { SandboxInfo, SandboxLabels } from "../types.ts";
import type {
	ContainerBackend,
	CreateContainerOpts,
	ProxyTarget,
} from "./backend.ts";
import { LEGACY_LIFECYCLE, type SandboxLifecycle } from "./lifecycle.ts";

const REGISTRY = "ghcr.io/circlesac";

/**
 * A template ID is `name` or `name:tag`; its image is `sandbox-<name>:<tag>`,
 * with `latest` when no tag is given.
 */
export function templateImage(templateId: string): {
	repo: string;
	tag: string;
} {
	const colon = templateId.lastIndexOf(":");
	const name = colon === -1 ? templateId : templateId.slice(0, colon);
	const tag = colon === -1 ? "latest" : templateId.slice(colon + 1);
	return { repo: `sandbox-${name}`, tag };
}

function localImageName(templateId: string) {
	const { repo, tag } = templateImage(templateId);
	return `${repo}:${tag}`;
}

function registryImageName(templateId: string) {
	const { repo, tag } = templateImage(templateId);
	return `${REGISTRY}/${repo}:${tag}`;
}

/** A template image this server built, committed, or pulled. */
export interface TemplateImage {
	/** `sandbox-<name>:<tag>` */
	ref: string;
	id: string;
	createdAt: string;
	labels: Record<string, string>;
}

interface DockerTimeoutState {
	startedAt: string;
	timeoutSec: number;
}

export class DockerService implements ContainerBackend {
	readonly type = "docker" as const;
	readonly supportsPause = true;
	readonly supportsFilesystemPause = true;
	readonly envdChecksAccessToken = true;
	readonly envdAcceptsAccessToken = true;
	private docker: Docker;
	private timeoutState = new Map<string, DockerTimeoutState>();
	private timeoutStatePath: string | null;
	private pulls = new Map<string, Promise<void>>();
	private imagePullWaitMs: number;

	constructor(opts: {
		socketPath: string;
		statePath?: string | null;
		imagePullWaitMs?: number;
	}) {
		this.docker = new Docker({ socketPath: opts.socketPath });
		// The E2B SDK retries a 503 that carries Should-Retry within its 60 s
		// request timeout, so answer within a fraction of it and let the SDK
		// come back rather than holding one attempt for the whole window.
		this.imagePullWaitMs = opts.imagePullWaitMs ?? 10_000;
		this.timeoutStatePath =
			opts.statePath === undefined
				? join(homedir(), ".sandbox", "docker-timeouts.json")
				: opts.statePath;
		this.loadTimeoutState();
	}

	/**
	 * Resolves a template to an image without contacting the registry when a
	 * copy is already cached. When the image has to be downloaded, waits at
	 * most imagePullWaitMs and then answers with a retryable error; the
	 * download continues in the background and a retry picks it up.
	 */
	async resolveImage(templateId: string): Promise<string> {
		const local = await this.localTemplateImage(templateId);
		if (local) return local;

		const remote = registryImageName(templateId);
		if (await this.imageExists(remote)) return remote;

		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = new Promise<"waiting">((resolve) => {
			timer = setTimeout(() => resolve("waiting"), this.imagePullWaitMs);
		});
		const pulling = this.pullImage(templateId).then(() => "pulled" as const);
		// The download continues after a "still downloading" answer; a later
		// failure is reported to the next request, not left unhandled.
		pulling.catch(() => {});
		try {
			const outcome = await Promise.race([pulling, waited]);
			if (outcome === "waiting") {
				throw new RetryableError(
					`Template "${templateId}" image ${remote} is still downloading; retry shortly`,
					5,
				);
			}
			return remote;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Starts downloading a template image in the background unless it is cached. */
	prefetchImage(templateId: string): void {
		(async () => {
			if (await this.imageExists(localImageName(templateId))) return;
			if (await this.imageExists(registryImageName(templateId))) return;
			await this.pullImage(templateId);
			console.log(`Prefetched ${registryImageName(templateId)}`);
		})().catch((err) => {
			console.warn(
				`Prefetching template "${templateId}" failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	/** Saves a container's filesystem as a template image (docker commit). */
	async commitTemplate(
		sandboxId: string,
		templateId: string,
		labels: Record<string, string>,
	): Promise<void> {
		const { repo, tag } = templateImage(templateId);
		await this.docker.getContainer(sandboxId).commit({
			repo,
			tag,
			pause: true,
			changes: Object.entries(labels).map(
				([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`,
			),
		});
	}

	/** Lists template images, optionally only those carrying a label. */
	async listTemplateImages(label?: string): Promise<TemplateImage[]> {
		const images = await this.docker.listImages(
			label ? { filters: { label: [label] } } : {},
		);
		return images.flatMap((image) =>
			(image.RepoTags ?? [])
				.filter((ref) => ref.startsWith("sandbox-"))
				.map((ref) => ({
					ref,
					id: image.Id,
					createdAt: new Date(image.Created * 1000).toISOString(),
					labels: image.Labels ?? {},
				})),
		);
	}

	async templateExists(templateId: string): Promise<boolean> {
		return (await this.localTemplateImage(templateId)) !== null;
	}

	/**
	 * The local image of a template. A bare name means its "latest" build, or
	 * for a snapshot, which E2B tags "default", that tag.
	 */
	private async localTemplateImage(templateId: string): Promise<string | null> {
		const local = localImageName(templateId);
		if (await this.imageExists(local)) return local;
		if (templateId.includes(":")) return null;
		const snapshot = localImageName(`${templateId}:default`);
		return (await this.imageExists(snapshot)) ? snapshot : null;
	}

	async tagTemplate(sourceTemplateId: string, tags: string[]): Promise<string> {
		const source = this.docker.getImage(
			(await this.localTemplateImage(sourceTemplateId)) ??
				localImageName(sourceTemplateId),
		);
		const info = await source.inspect();
		const { repo } = templateImage(sourceTemplateId);
		for (const tag of tags) await source.tag({ repo, tag });
		return info.Id;
	}

	/** Removes image tags; returns how many existed. */
	async removeTemplateImages(refs: string[]): Promise<number> {
		let removed = 0;
		for (const ref of refs) {
			try {
				await this.docker.getImage(ref).remove({ force: true });
				removed++;
			} catch (err: unknown) {
				if (!isDockerNotFound(err)) throw err;
			}
		}
		return removed;
	}

	/** Builds `sandbox-<templateId>` from a directory holding a Dockerfile. */
	async buildTemplate(
		contextDir: string,
		entries: string[],
		templateId: string,
		opts: { noCache: boolean; onLog: (line: string, isError: boolean) => void },
	): Promise<void> {
		const stream = await this.docker.buildImage(
			{ context: contextDir, src: entries },
			{ t: localImageName(templateId), nocache: opts.noCache, forcerm: true },
		);
		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(
				stream,
				(err: Error | null) => (err ? reject(err) : resolve()),
				(event: { stream?: string; error?: string }) => {
					if (event.error) opts.onLog(event.error, true);
					for (const line of (event.stream ?? "").split("\n")) {
						if (line.trim()) opts.onLog(line, false);
					}
				},
			);
		});
	}

	/** The start and ready commands a template recorded, from its image labels. */
	async templateCommands(
		sandboxId: string,
	): Promise<{ startCmd?: string; readyCmd?: string }> {
		const info = await this.docker.getContainer(sandboxId).inspect();
		const labels = info.Config.Labels ?? {};
		return {
			startCmd: labels["e2b.start-cmd"] || undefined,
			readyCmd: labels["e2b.ready-cmd"] || undefined,
		};
	}

	private envdVersions = new Map<string, string | null>(); // image ID → version
	private envdVersionBySandbox = new Map<string, string>(); // known, no inspect needed

	/** The envd version in the sandbox's image, from `envd -version`, cached per image and sandbox. */
	async envdVersion(sandboxId: string): Promise<string | null> {
		const known = this.envdVersionBySandbox.get(sandboxId);
		if (known) return known;
		const info = await this.docker.getContainer(sandboxId).inspect();
		let version = this.envdVersions.get(info.Image);
		if (version === undefined) {
			if (!info.State.Running || info.State.Paused) return null;
			const output = await this.execOutput(sandboxId, [
				"/usr/bin/envd",
				"-version",
			]);
			version = output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
			this.envdVersions.set(info.Image, version);
		}
		if (version) this.envdVersionBySandbox.set(sandboxId, version);
		return version;
	}

	private async execOutput(sandboxId: string, cmd: string[]): Promise<string> {
		const exec = await this.docker.getContainer(sandboxId).exec({
			Cmd: cmd,
			AttachStdout: true,
			AttachStderr: true,
		});
		const stream = await exec.start({});
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve) => {
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", resolve);
			stream.on("close", resolve);
			stream.on("error", () => resolve());
		});
		// Docker multiplexes stdout and stderr with 8-byte frame headers.
		const raw = Buffer.concat(chunks);
		const out: Buffer[] = [];
		for (let i = 0; i + 8 <= raw.length; ) {
			const size = raw.readUInt32BE(i + 4);
			out.push(raw.subarray(i + 8, i + 8 + size));
			i += 8 + size;
		}
		return Buffer.concat(out).toString("utf-8");
	}

	/**
	 * Environment variables baked into the sandbox's image (template ENV steps,
	 * and a forked or snapshotted sandbox's own variables). envd does not pass
	 * its environment to the processes it starts, so they go to /init.
	 */
	async imageEnv(sandboxId: string): Promise<Record<string, string>> {
		const info = await this.docker.getContainer(sandboxId).inspect();
		const env: Record<string, string> = {};
		for (const entry of info.Config.Env ?? []) {
			const eq = entry.indexOf("=");
			const key = eq === -1 ? entry : entry.slice(0, eq);
			if (key === "HOSTNAME" || key === "HOME") continue;
			env[key] = eq === -1 ? "" : entry.slice(eq + 1);
		}
		return env;
	}

	/**
	 * Starts a built template's start command and waits for its ready command
	 * to succeed, within the same budget as envd's health check.
	 */
	async runTemplateStart(sandboxId: string): Promise<void> {
		const { startCmd, readyCmd } = await this.templateCommands(sandboxId);
		if (startCmd) {
			await this.exec(sandboxId, startCmd, {
				user: config.defaultUser,
				detach: true,
			});
		}
		if (!readyCmd) return;
		const deadline = Date.now() + config.envdHealthTimeoutMs;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const code = await this.exec(sandboxId, readyCmd, {
				user: config.defaultUser,
				detach: false,
				timeoutMs: remaining,
			});
			if (code === 0) return;
			const waitMs = Math.min(
				config.envdHealthIntervalMs,
				deadline - Date.now(),
			);
			if (waitMs > 0) {
				await new Promise((r) => setTimeout(r, waitMs));
			}
		}
		throw new Error(
			`The template's ready command did not succeed within ${config.envdHealthTimeoutMs} ms: ${readyCmd}`,
		);
	}

	/**
	 * Runs a shell command in a sandbox as a user. Detached commands return at
	 * once with exit code null; others wait and return their exit code.
	 */
	async exec(
		sandboxId: string,
		cmd: string,
		opts: { user: string; detach: boolean; timeoutMs?: number },
	): Promise<number | null> {
		const exec = await this.docker.getContainer(sandboxId).exec({
			Cmd: ["/bin/sh", "-c", cmd],
			User: opts.user,
			AttachStdout: !opts.detach,
			AttachStderr: !opts.detach,
		});
		if (opts.detach) {
			await exec.start({ Detach: true });
			return null;
		}
		const stream = await exec.start({});
		const waitForStream = new Promise<void>((resolve) => {
			stream.on("end", resolve);
			stream.on("close", resolve);
			stream.on("error", () => resolve());
			stream.resume();
		});
		if (opts.timeoutMs !== undefined) {
			const finished = await Promise.race([
				waitForStream.then(() => true),
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), opts.timeoutMs),
				),
			]);
			if (!finished) return null;
		} else {
			await waitForStream;
		}
		return (await exec.inspect()).ExitCode ?? null;
	}

	private async imageExists(name: string): Promise<boolean> {
		try {
			await this.docker.getImage(name).inspect();
			return true;
		} catch (err: unknown) {
			if (isDockerNotFound(err)) return false;
			throw err;
		}
	}

	/** One download per image, shared by every request that needs it. */
	private pullImage(templateId: string): Promise<void> {
		const remote = registryImageName(templateId);
		let pull = this.pulls.get(remote);
		if (!pull) {
			pull = new Promise<void>((resolve, reject) => {
				this.docker.pull(
					remote,
					(err: Error | null, stream: NodeJS.ReadableStream) => {
						if (err) return reject(err);
						this.docker.modem.followProgress(stream, (err: Error | null) =>
							err ? reject(err) : resolve(),
						);
					},
				);
			})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					// Only a missing image is "not found"; a network or registry
					// failure keeps its own message.
					if (/not found|manifest unknown|pull access denied/i.test(message)) {
						throw new NotFoundError(
							`Template "${templateId}" not found. Checked:\n  - ${localImageName(templateId)}\n  - ${remote}`,
						);
					}
					throw new Error(`Could not download ${remote}: ${message}`);
				})
				.finally(() => this.pulls.delete(remote));
			this.pulls.set(remote, pull);
		}
		return pull;
	}

	async createContainer(
		opts: CreateContainerOpts,
	): Promise<{ instanceId: string; hostPort: number }> {
		const image = await this.resolveImage(
			opts.imageTemplateId ?? opts.templateId,
		);

		const labels: Record<string, string> = {
			"e2b.sandbox-id": opts.sandboxId,
			"e2b.access-token": opts.accessToken,
			"e2b.template-id": opts.templateId,
			"e2b.created-at": new Date().toISOString(),
			"e2b.timeout": String(opts.timeoutSec),
			"e2b.lifecycle": JSON.stringify(opts.lifecycle),
		};
		if (opts.metadata) {
			labels["e2b.metadata"] = JSON.stringify(opts.metadata);
		}

		const env = opts.envVars
			? Object.entries(opts.envVars).map(([k, v]) => `${k}=${v}`)
			: [];

		const container = await this.docker.createContainer({
			Image: image,
			name: opts.sandboxId,
			Labels: labels,
			Env: env,
			ExposedPorts: { [`${config.envdPort}/tcp`]: {} },
			HostConfig: {
				PortBindings: {
					[`${config.envdPort}/tcp`]: [{ HostPort: "0" }],
				},
			},
		});

		await container.start();

		const info = await container.inspect();
		const portBindings = info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
		const hostPort = Number(portBindings?.[0]?.HostPort);

		if (!hostPort) {
			await container.remove({ force: true });
			throw new Error(`Failed to get host port for ${opts.sandboxId}`);
		}

		return { instanceId: info.Id, hostPort };
	}

	async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
		try {
			const container = this.docker.getContainer(sandboxId);
			const info = await container.inspect();
			// A container being removed is already gone for every caller.
			if (isGone(info.State.Status)) return null;
			// Only this server's sandboxes: never another container with that name.
			if (info.Config.Labels?.["e2b.sandbox-id"] !== sandboxId) return null;
			return this.parseContainerInfo(info);
		} catch (err: unknown) {
			if (isDockerNotFound(err)) return null;
			throw err;
		}
	}

	async removeContainer(sandboxId: string): Promise<boolean> {
		const container = this.docker.getContainer(sandboxId);
		const image = await container.inspect().then(
			(info) => ({ name: info.Config.Image, id: info.Image }),
			() => null,
		);
		try {
			await container.remove({ force: true });
		} catch (err: unknown) {
			// 409: another remove, such as a timeout's, is already under way.
			if (!isDockerNotFound(err) && !isDockerConflict(err)) throw err;
			this.clearTimeoutState(sandboxId);
			return false;
		}
		this.clearTimeoutState(sandboxId);
		this.envdVersionBySandbox.delete(sandboxId);
		// fork() drops the image's name at once; the container still records it.
		if (image?.name.startsWith("sandbox-fork-")) {
			await this.removeForkImage(image.id);
		}
		return true;
	}

	/**
	 * A fork's image exists only for its forks, so it goes with the last of
	 * them. Docker refuses (409) while another container, even a stopped one,
	 * still uses it.
	 */
	private async removeForkImage(imageId: string) {
		try {
			await this.docker.getImage(imageId).remove();
		} catch (err: unknown) {
			if (!isDockerNotFound(err) && !isDockerConflict(err)) {
				console.warn(`Could not remove fork image ${imageId}: ${err}`);
			}
		}
	}

	/**
	 * Pauses a sandbox. Keeping memory freezes its processes (docker pause), as
	 * an E2B pause does; otherwise the container stops and only its filesystem
	 * survives.
	 */
	async stopContainer(
		sandboxId: string,
		opts: { keepMemory?: boolean } = {},
	): Promise<boolean> {
		const container = this.docker.getContainer(sandboxId);
		try {
			if (opts.keepMemory) {
				const info = await container.inspect();
				if (info.State.Running && !info.State.Paused) await container.pause();
			} else {
				await container.stop();
			}
		} catch (err: unknown) {
			if (isDockerNotFound(err)) {
				this.clearTimeoutState(sandboxId);
				return false;
			}
			// Already stopped
			if (!isDockerNotModified(err)) throw err;
		}
		this.clearTimeoutState(sandboxId);
		return true;
	}

	async startContainer(sandboxId: string): Promise<{ hostPort: number }> {
		const container = this.docker.getContainer(sandboxId);
		const before = await container.inspect();
		if (isGone(before.State.Status)) {
			throw new NotFoundError(`Sandbox ${sandboxId} not found`);
		}
		if (before.State.Paused) {
			await container.unpause();
		} else if (!before.State.Running) {
			try {
				await container.start();
			} catch (err: unknown) {
				if (!isDockerNotModified(err)) throw err;
			}
		}

		const info = await container.inspect();
		const portBindings = info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
		const hostPort = Number(portBindings?.[0]?.HostPort);

		if (!hostPort) {
			throw new Error(`Failed to get host port after starting ${sandboxId}`);
		}

		return { hostPort };
	}

	/**
	 * envd is reached through its published host port. Any other port is reached
	 * on the container's own address, which the host can route to on Linux and
	 * on OrbStack (not on Docker Desktop for Mac).
	 */
	async resolveTarget(
		sandboxId: string,
		port: number,
	): Promise<ProxyTarget | null> {
		let info: Docker.ContainerInspectInfo;
		try {
			info = await this.docker.getContainer(sandboxId).inspect();
		} catch (err: unknown) {
			if (isDockerNotFound(err)) return null;
			throw err;
		}
		if (!info.State.Running || info.State.Paused) return null;
		if (port === config.envdPort) {
			const hostPort = Number(
				info.NetworkSettings.Ports[`${config.envdPort}/tcp`]?.[0]?.HostPort,
			);
			return hostPort ? { host: "localhost", port: hostPort } : null;
		}
		const address = Object.values(info.NetworkSettings.Networks ?? {}).find(
			(n) => n?.IPAddress,
		)?.IPAddress;
		return address ? { host: address, port } : null;
	}

	refreshTimeout(sandboxId: string, timeoutSec: number): void {
		this.timeoutState.set(sandboxId, {
			startedAt: new Date().toISOString(),
			timeoutSec,
		});
		this.persistTimeoutState();
	}

	async listSandboxes(filters?: {
		state?: "running" | "paused";
	}): Promise<SandboxInfo[]> {
		const containers = await this.docker.listContainers({
			all: true,
			filters: { label: ["e2b.sandbox-id"] },
		});

		const results: SandboxInfo[] = [];
		const present = new Set<string>();
		for (const c of containers) {
			const sandboxId = c.Labels["e2b.sandbox-id"];
			if (sandboxId) present.add(sandboxId);
			if (isGone(c.State)) continue;

			let sandbox: SandboxInfo | null;
			try {
				sandbox =
					c.State === "running"
						? await this.docker
								.getContainer(c.Id)
								.inspect()
								.then((info) => this.parseContainerInfo(info))
						: this.parseContainerListInfo(c);
			} catch (err: unknown) {
				if (!isDockerNotFound(err)) throw err;
				if (sandboxId) this.clearTimeoutState(sandboxId);
				continue;
			}
			if (!sandbox) continue;
			if (filters?.state && sandbox.state !== filters.state) continue;
			results.push(sandbox);
		}
		let pruned = false;
		for (const sandboxId of this.timeoutState.keys()) {
			if (present.has(sandboxId)) continue;
			this.timeoutState.delete(sandboxId);
			pruned = true;
		}
		if (pruned) this.persistTimeoutState();
		return results;
	}

	private parseContainerInfo(info: Docker.ContainerInspectInfo): SandboxInfo {
		const labels = info.Config.Labels as unknown as SandboxLabels;
		const portBindings = info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
		const hostPort = Number(portBindings?.[0]?.HostPort) || 0;
		const sandboxId = labels["e2b.sandbox-id"] ?? info.Name.replace(/^\//, "");
		const timeout =
			info.State.Running && !info.State.Paused
				? this.timeoutState.get(sandboxId)
				: undefined;

		return {
			sandboxId,
			instanceId: info.Id,
			accessToken: labels["e2b.access-token"] ?? "",
			templateId: labels["e2b.template-id"] ?? "base",
			startedAt: labels["e2b.created-at"] ?? info.Created,
			timeoutFrom:
				info.State.Running && !info.State.Paused
					? (timeout?.startedAt ?? info.State.StartedAt)
					: (labels["e2b.created-at"] ?? info.Created),
			timeoutSec:
				timeout?.timeoutSec ??
				Number(labels["e2b.timeout"] ?? config.defaultTimeoutSec),
			hostPort,
			state: info.State.Running && !info.State.Paused ? "running" : "paused",
			metadata: parseJsonLabel(labels["e2b.metadata"]),
			lifecycle: parseLifecycle(labels),
		};
	}

	private parseContainerListInfo(c: Docker.ContainerInfo): SandboxInfo | null {
		const labels = c.Labels as unknown as SandboxLabels;
		if (!labels["e2b.sandbox-id"]) return null;

		const portMapping = c.Ports.find((p) => p.PrivatePort === config.envdPort);

		return {
			sandboxId: labels["e2b.sandbox-id"],
			instanceId: c.Id,
			accessToken: labels["e2b.access-token"] ?? "",
			templateId: labels["e2b.template-id"] ?? "base",
			startedAt: labels["e2b.created-at"] ?? "",
			timeoutFrom: labels["e2b.created-at"] ?? "",
			timeoutSec: Number(labels["e2b.timeout"] ?? config.defaultTimeoutSec),
			hostPort: portMapping?.PublicPort ?? 0,
			state: c.State === "running" ? "running" : "paused",
			metadata: parseJsonLabel(labels["e2b.metadata"]),
			lifecycle: parseLifecycle(labels),
		};
	}

	private loadTimeoutState(): void {
		if (!this.timeoutStatePath || !existsSync(this.timeoutStatePath)) return;
		try {
			const stored = JSON.parse(readFileSync(this.timeoutStatePath, "utf8"));
			if (!stored || typeof stored !== "object" || Array.isArray(stored))
				return;
			for (const [sandboxId, value] of Object.entries(stored)) {
				if (
					value &&
					typeof value === "object" &&
					"startedAt" in value &&
					typeof value.startedAt === "string" &&
					!Number.isNaN(Date.parse(value.startedAt)) &&
					"timeoutSec" in value &&
					typeof value.timeoutSec === "number" &&
					Number.isFinite(value.timeoutSec) &&
					value.timeoutSec > 0
				) {
					this.timeoutState.set(sandboxId, {
						startedAt: value.startedAt,
						timeoutSec: value.timeoutSec,
					});
				}
			}
		} catch (err) {
			console.warn(
				`Failed to read Docker timeout state: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private persistTimeoutState(): void {
		if (!this.timeoutStatePath) return;
		mkdirSync(dirname(this.timeoutStatePath), { recursive: true });
		const tempPath = `${this.timeoutStatePath}.tmp`;
		writeFileSync(
			tempPath,
			JSON.stringify(Object.fromEntries(this.timeoutState), null, 2) + "\n",
		);
		renameSync(tempPath, this.timeoutStatePath);
	}

	private clearTimeoutState(sandboxId: string): void {
		if (!this.timeoutState.delete(sandboxId)) return;
		this.persistTimeoutState();
	}
}

function isDockerNotFound(err: unknown): boolean {
	return (
		err instanceof Error &&
		"statusCode" in err &&
		(err as { statusCode: number }).statusCode === 404
	);
}

function isDockerNotModified(err: unknown): boolean {
	return (
		err instanceof Error &&
		"statusCode" in err &&
		(err as { statusCode: number }).statusCode === 304
	);
}

function parseLifecycle(labels: SandboxLabels): SandboxLifecycle {
	return {
		...LEGACY_LIFECYCLE,
		...parseJsonLabel<Partial<SandboxLifecycle>>(labels["e2b.lifecycle"]),
	};
}

/**
 * A JSON label, or undefined when absent or malformed: one bad container
 * must not break listing every other sandbox.
 */
function parseJsonLabel<T = Record<string, string>>(
	raw: string | undefined,
): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function isGone(status: string | undefined): boolean {
	return status === "removing" || status === "dead";
}

function isDockerConflict(err: unknown): boolean {
	return (
		err instanceof Error &&
		"statusCode" in err &&
		(err as { statusCode: number }).statusCode === 409
	);
}
