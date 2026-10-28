import { config } from "../config.ts";
import { ConflictError, NotFoundError, UnsupportedError } from "../errors.ts";
import {
	E2B_CLIENT_ID,
	generateAccessToken,
	generateImageSuffix,
	generateSandboxId,
	isImageName,
} from "../lib/id.ts";
import type { SandboxInfo } from "../types.ts";
import {
	type BackendMap,
	type ContainerBackend,
	type Platform,
	resolvePlatform,
} from "./backend.ts";
import type { EnvdService } from "./envd.ts";
import { type CreateOptions, lifecycleFromCreate } from "./lifecycle.ts";
import { clearPortCache, clearRoutes, registerToken } from "./proxy.ts";
import type { TtlService } from "./ttl.ts";

export interface CreateRequest extends CreateOptions {
	templateID?: string;
	/** Internal: the image to start from when it differs from templateID (forks). */
	imageTemplateID?: string;
	timeout?: number;
	timeoutSec?: number;
	envVars?: Record<string, string>;
	metadata?: Record<string, string>;
}

/** Where the client reached this server, so sandbox URLs point back to it. */
export interface RequestContext {
	domain?: string | null;
}

export class SandboxService {
	// Track which platform each sandbox belongs to
	private _sandboxPlatform = new Map<string, Platform>();
	private resumes = new Map<string, Promise<boolean>>();
	private pauses = new Map<string, Promise<boolean>>();
	private connects = new Map<string, Promise<void>>();

	constructor(
		private backends: BackendMap,
		private envd: EnvdService,
		private ttl: TtlService,
	) {}

	/** Single backend for backwards compat (proxy, TTL reconciliation). */
	get backend(): ContainerBackend {
		return this.backends.linux;
	}

	private get allBackends(): ContainerBackend[] {
		return [this.backends.linux, this.backends.macos].filter(
			(b): b is ContainerBackend => b != null,
		);
	}

	private backendFor(platform: Platform): ContainerBackend {
		const b = this.backends[platform];
		if (!b) {
			throw new UnsupportedError(
				`No backend configured for platform "${platform}"`,
			);
		}
		return b;
	}

	private backendForSandbox(sandboxId: string): ContainerBackend {
		const platform = this._sandboxPlatform.get(sandboxId);
		return platform ? this.backendFor(platform) : this.backends.linux;
	}

	/** Finds a sandbox on whichever backend holds it, including after a restart. */
	async locate(
		sandboxId: string,
	): Promise<{ info: SandboxInfo; backend: ContainerBackend } | null> {
		const known = this._sandboxPlatform.get(sandboxId);
		const candidates = known ? [this.backendFor(known)] : this.allBackends;
		for (const backend of candidates) {
			const info = await backend.inspectSandbox(sandboxId);
			if (info) return { info, backend };
		}
		return null;
	}

	/**
	 * The stored ID for one a client sent. E2B clients may append an old client
	 * ID (8 hex digits) after the sandbox ID: <sandboxId>-<clientId>.
	 */
	private async canonical(sandboxId: string): Promise<string> {
		if (await this.locate(sandboxId)) return sandboxId;
		const stripped = sandboxId.match(/^(.+)-[0-9a-f]{8}$/)?.[1];
		return stripped && (await this.locate(stripped)) ? stripped : sandboxId;
	}

	private prepare(req: CreateRequest) {
		const platform = resolvePlatform(req.metadata);
		const backend = this.backendFor(platform);
		return {
			sandboxId: generateSandboxId(),
			accessToken: generateAccessToken(),
			templateId: req.templateID ?? "base",
			timeoutSec: this.timeoutWithinLimit(
				req.timeoutSec ?? req.timeout ?? config.defaultTimeoutSec,
			),
			platform,
			backend,
			lifecycle: lifecycleFromCreate(req, backend),
		};
	}

	private async boot(
		req: CreateRequest,
		p: ReturnType<SandboxService["prepare"]>,
	): Promise<void> {
		const { hostPort } = await p.backend.createContainer({
			sandboxId: p.sandboxId,
			accessToken: p.accessToken,
			templateId: p.templateId,
			imageTemplateId: req.imageTemplateID,
			timeoutSec: p.timeoutSec,
			envVars: req.envVars,
			metadata: req.metadata,
			lifecycle: p.lifecycle,
		});
		this._sandboxPlatform.set(p.sandboxId, p.platform);

		try {
			await this.envd.waitForHealth(hostPort);
			await this.envd.init(hostPort, {
				accessToken: this.envdToken(
					p.backend,
					p.lifecycle.secure,
					p.accessToken,
				),
				envVars: {
					...(await p.backend.imageEnv?.(p.sandboxId)),
					...req.envVars,
				},
			});
			await p.backend.runTemplateStart?.(p.sandboxId);
		} catch (err) {
			await p.backend.removeContainer(p.sandboxId).catch(() => {});
			this._sandboxPlatform.delete(p.sandboxId);
			throw err;
		}

		registerToken(p.accessToken, p.sandboxId);
		this.ttl.start(p.sandboxId, p.timeoutSec, () => this.expire(p.sandboxId));
	}

	/**
	 * A requested timeout, rejected outside E2B's bounds as E2B rejects it:
	 * create, connect, and fork need at least a second; setTimeout and
	 * refresh accept 0.
	 */
	private timeoutWithinLimit(timeoutSec: number, min = 1): number {
		if (timeoutSec < min) {
			throw new UnsupportedError(
				min === 1
					? "timeout must be greater than 0"
					: "timeout must not be negative",
			);
		}
		if (timeoutSec > config.maxTimeoutSec) {
			throw new UnsupportedError(
				`timeout must be at most ${config.maxTimeoutSec} seconds`,
			);
		}
		return timeoutSec;
	}

	/** The token envd is given; the proxy also checks it for backends whose envd does not. */
	private envdToken(
		backend: ContainerBackend,
		secure: boolean,
		accessToken: string,
	): string | undefined {
		return secure && backend.envdAcceptsAccessToken ? accessToken : undefined;
	}

	private response(
		p: {
			sandboxId: string;
			templateId: string;
			accessToken: string;
			lifecycle: { secure: boolean; trafficAccessToken: string | null };
		},
		ctx: RequestContext,
		envdVersion = config.envdVersion,
	) {
		return {
			sandboxID: p.sandboxId,
			templateID: templateName(p.templateId),
			clientID: E2B_CLIENT_ID,
			envdVersion,
			envdAccessToken: p.lifecycle.secure ? p.accessToken : null,
			trafficAccessToken: p.lifecycle.trafficAccessToken,
			domain: ctx.domain ?? null,
		};
	}

	/**
	 * Async create — returns sandbox ID immediately, boots VM in background.
	 * Caller should poll GET /sandboxes/:id to check when ready.
	 */
	async createAsync(req: CreateRequest, ctx: RequestContext = {}) {
		const p = this.prepare(req);
		this._sandboxPlatform.set(p.sandboxId, p.platform);
		registerToken(p.accessToken, p.sandboxId);

		(async () => {
			try {
				await this.boot(req, p);
				// If JIT_CONFIG envVar is set, write it to /tmp/jitconfig for the runner LaunchAgent
				if (req.envVars?.JIT_CONFIG) {
					const info = await p.backend.inspectSandbox(p.sandboxId);
					try {
						await fetch(
							`http://localhost:${info?.hostPort}/files?path=/tmp/jitconfig`,
							{ method: "POST", body: req.envVars.JIT_CONFIG },
						);
						console.log(
							`[async] Wrote /tmp/jitconfig to sandbox ${p.sandboxId}`,
						);
					} catch (err) {
						console.error(`[async] Failed to write jitconfig:`, err);
					}
				}
				console.log(`[async] Sandbox ${p.sandboxId} ready`);
			} catch (err) {
				console.error(`[async] Sandbox ${p.sandboxId} failed:`, err);
				this._sandboxPlatform.delete(p.sandboxId);
			}
		})();

		return this.response(p, ctx);
	}

	async create(req: CreateRequest, ctx: RequestContext = {}) {
		const p = this.prepare(req);
		await this.boot(req, p);
		return this.response(
			p,
			ctx,
			await this.envdVersionOf(p.backend, p.sandboxId),
		);
	}

	/** The sandbox's real envd version where the backend can tell, else the default. */
	private async envdVersionOf(
		backend: ContainerBackend,
		sandboxId: string,
	): Promise<string> {
		const version = await backend.envdVersion?.(sandboxId).catch(() => null);
		return version ?? config.envdVersion;
	}

	async getInfo(sandboxId: string) {
		sandboxId = await this.canonical(sandboxId);
		const found = await this.locate(sandboxId);
		if (!found) return null;
		return this.detail(
			found.info,
			await this.envdVersionOf(found.backend, sandboxId),
		);
	}

	private detail(info: SandboxInfo, envdVersion: string) {
		return {
			sandboxID: info.sandboxId,
			templateID: templateName(info.templateId),
			clientID: E2B_CLIENT_ID,
			envdVersion,
			domain: null,
			startedAt: info.createdAt,
			endAt: new Date(
				new Date(info.createdAt).getTime() + info.timeoutSec * 1000,
			).toISOString(),
			metadata: info.metadata,
			state: info.state,
			// E2B's template alias: the name the sandbox was created from.
			alias: info.templateId.split(":")[0],
			envdAccessToken: info.lifecycle.secure ? info.accessToken : undefined,
		};
	}

	async kill(sandboxId: string): Promise<boolean> {
		sandboxId = await this.canonical(sandboxId);
		this.ttl.clear(sandboxId);
		clearPortCache(sandboxId);
		const found = await this.locate(sandboxId);
		const backend = found?.backend ?? this.backendForSandbox(sandboxId);
		const result = await backend.removeContainer(sandboxId);
		this._sandboxPlatform.delete(sandboxId);
		return result;
	}

	/**
	 * Pauses a sandbox. keepMemory freezes its processes, as an E2B pause does
	 * by default; false keeps only the filesystem.
	 */
	async pause(sandboxId: string, keepMemory = true): Promise<boolean> {
		sandboxId = await this.canonical(sandboxId);
		// Concurrent pauses of one sandbox share the first; a pause of a sandbox
		// that is already paused is a conflict, as in E2B.
		const found = await this.locate(sandboxId);
		// Checked after the lookup, so a pause that started meanwhile is shared.
		const pending = this.pauses.get(sandboxId);
		if (pending) return pending;
		if (!found) return false;
		const { backend, info } = found;
		if (!backend.supportsPause) {
			throw new UnsupportedError(
				`Pause is not supported by the ${backend.type} backend`,
			);
		}
		if (!keepMemory && !backend.supportsFilesystemPause) {
			throw new UnsupportedError(
				`The ${backend.type} backend cannot pause without keeping memory`,
			);
		}
		if (info.state === "paused") {
			throw new ConflictError(`Sandbox ${sandboxId} is already paused`);
		}
		const pause = (async () => {
			this.ttl.clear(sandboxId);
			clearRoutes(sandboxId);
			return backend.stopContainer(sandboxId, { keepMemory });
		})().finally(() => this.pauses.delete(sandboxId));
		this.pauses.set(sandboxId, pause);
		return pause;
	}

	/** Timeout handler: pause or kill as the sandbox's lifecycle says. */
	async expire(sandboxId: string): Promise<void> {
		try {
			const found = await this.locate(sandboxId);
			if (found?.info.state !== "running") return;
			const { lifecycle } = found.info;
			if (lifecycle.autoPause && found.backend.supportsPause) {
				await this.pause(sandboxId, lifecycle.keepMemory);
			} else {
				await this.kill(sandboxId);
			}
		} catch (err) {
			console.error(`Timeout handling for ${sandboxId} failed:`, err);
		}
	}

	async connect(
		sandboxId: string,
		timeoutSec?: number,
		ctx: RequestContext = {},
	) {
		sandboxId = await this.canonical(sandboxId);
		const requested = this.timeoutWithinLimit(
			timeoutSec ?? config.defaultTimeoutSec,
		);
		const found = await this.locate(sandboxId);
		if (!found) {
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		}
		const { info, backend } = found;

		// Concurrent connects share one resume.
		let resuming = this.connects.get(sandboxId);
		if (!resuming) {
			resuming = this.startAndInit(sandboxId, info, backend).finally(() =>
				this.connects.delete(sandboxId),
			);
			this.connects.set(sandboxId, resuming);
		}
		await resuming;

		// Connecting only ever extends a running sandbox's time; a shorter
		// request leaves its end time exactly as it was.
		const remaining =
			info.state === "running"
				? (new Date(info.createdAt).getTime() +
						info.timeoutSec * 1000 -
						Date.now()) /
					1000
				: 0;
		if (requested > remaining) {
			await backend.refreshTimeout?.(sandboxId, requested);
			this.ttl.start(sandboxId, requested, () => this.expire(sandboxId));
		} else if (info.state !== "running") {
			this.ttl.start(sandboxId, remaining, () => this.expire(sandboxId));
		}

		return this.response(
			{
				sandboxId: info.sandboxId,
				templateId: info.templateId,
				accessToken: info.accessToken,
				lifecycle: info.lifecycle,
			},
			ctx,
			await this.envdVersionOf(backend, sandboxId),
		);
	}

	private async startAndInit(
		sandboxId: string,
		info: SandboxInfo,
		backend: ContainerBackend,
	): Promise<void> {
		const { hostPort } = await backend.startContainer(sandboxId);
		this._sandboxPlatform.set(
			sandboxId,
			backend === this.backends.macos ? "macos" : "linux",
		);
		clearRoutes(sandboxId);

		await this.envd.waitForHealth(hostPort);
		await this.envd.init(hostPort, {
			accessToken: this.envdToken(
				backend,
				info.lifecycle.secure,
				info.accessToken,
			),
			envVars: await backend.imageEnv?.(sandboxId),
		});
		registerToken(info.accessToken, sandboxId);
	}

	/**
	 * Resumes a paused sandbox for proxied traffic when its lifecycle allows it.
	 * Concurrent requests share one resume. Returns whether the sandbox runs.
	 */
	async resumeForTraffic(sandboxId: string): Promise<boolean> {
		sandboxId = await this.canonical(sandboxId);
		const pending = this.resumes.get(sandboxId);
		if (pending) return pending;

		const resume = (async () => {
			const found = await this.locate(sandboxId);
			if (!found) return false;
			if (found.info.state === "running") return true;
			if (!found.info.lifecycle.autoResume) return false;
			await this.connect(sandboxId, found.info.timeoutSec);
			return true;
		})().finally(() => this.resumes.delete(sandboxId));
		this.resumes.set(sandboxId, resume);
		return resume;
	}

	/**
	 * Saves a sandbox's filesystem as a template that Sandbox.create() accepts.
	 * Memory is not captured: a sandbox created from it starts its processes anew.
	 */
	async snapshot(sandboxId: string, opts: { name?: string; memory?: boolean }) {
		sandboxId = await this.canonical(sandboxId);
		const found = await this.locate(sandboxId);
		if (!found)
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		const { backend } = found;
		if (!backend.commitTemplate) {
			throw new UnsupportedError(
				`Snapshots are not supported by the ${backend.type} backend`,
			);
		}
		if (opts.memory === true) {
			throw new UnsupportedError(
				"Memory snapshots are not supported; a snapshot keeps only the filesystem",
			);
		}
		// E2B snapshot IDs are template references, <name>:<tag>, the tag
		// "default" unless the name gives one; names carry no tag.
		const [name, tag = "default"] = (
			opts.name ?? `snapshot-${generateImageSuffix()}`
		).split(":");
		if (!name || !isImageName(name) || !/^[\w][\w.-]{0,127}$/.test(tag)) {
			throw new UnsupportedError(
				`Snapshot name "${opts.name}" must be a lowercase name, optionally with :<tag>`,
			);
		}
		const snapshotID = `${name}:${tag}`;
		// Set every label, so none is inherited from a snapshot this sandbox
		// started from.
		await backend.commitTemplate(sandboxId, snapshotID, {
			"e2b.snapshot": "true",
			"e2b.snapshot-of": sandboxId,
			"e2b.snapshot-name": opts.name ? name : "",
			"e2b.snapshot-at": String(Date.now()),
		});
		// An unnamed snapshot has no names, as in E2B.
		return { snapshotID, names: opts.name ? [name] : [] };
	}

	/**
	 * Forks a running sandbox: saves its filesystem and starts count sandboxes
	 * from it with the same template, lifecycle, and metadata. Memory and running processes are
	 * not carried over. Each result holds the sandbox or the error that
	 * stopped it.
	 */
	async fork(
		sandboxId: string,
		opts: { timeout?: number; count?: number },
		ctx: RequestContext = {},
	) {
		sandboxId = await this.canonical(sandboxId);
		const count = opts.count ?? 1;
		if (!Number.isInteger(count) || count < 1 || count > 100) {
			throw new UnsupportedError("count must be an integer from 1 to 100");
		}
		const found = await this.locate(sandboxId);
		if (!found)
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		const { info, backend } = found;
		if (!backend.commitTemplate) {
			throw new UnsupportedError(
				`Forks are not supported by the ${backend.type} backend`,
			);
		}
		if (info.state !== "running") {
			throw new ConflictError(
				`Sandbox ${sandboxId} is paused; resume it to fork it`,
			);
		}

		this.timeoutWithinLimit(opts.timeout ?? 15);
		const forkTemplate = `fork-${generateImageSuffix()}`;
		await backend.commitTemplate(sandboxId, forkTemplate, {
			"e2b.fork-of": sandboxId,
		});
		const { lifecycle } = info;
		const request: CreateRequest = {
			// Forks report the source's template; E2B gives them 15 s by default.
			templateID: info.templateId,
			imageTemplateID: forkTemplate,
			timeout: opts.timeout ?? 15,
			metadata: info.metadata,
			autoPause: lifecycle.autoPause,
			autoPauseMemory: lifecycle.keepMemory,
			autoResume: { enabled: lifecycle.autoResume },
			secure: lifecycle.secure,
			network: { allowPublicTraffic: lifecycle.trafficAccessToken === null },
		};
		try {
			const results = [];
			for (let i = 0; i < count; i++) {
				try {
					results.push({ sandbox: await this.create(request, ctx) });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					results.push({ error: { code: 500, message } });
				}
			}
			return results;
		} finally {
			// The forks keep the image's layers; only the temporary name goes.
			await backend
				.removeTemplateImages?.([`sandbox-${forkTemplate}:latest`])
				.catch(() => 0);
		}
	}

	/**
	 * The sandbox's current resource use, read from envd's /metrics. This
	 * server keeps no history, so the list holds one sample, or none while
	 * the sandbox is paused.
	 */
	async metrics(sandboxId: string) {
		sandboxId = await this.canonical(sandboxId);
		const found = await this.locate(sandboxId);
		if (!found)
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		const { info, backend } = found;
		if (info.state !== "running") return [];
		const target = await backend.resolveTarget(sandboxId, config.envdPort);
		if (!target) return [];
		const res = await fetch(`http://${target.host}:${target.port}/metrics`, {
			headers: { "X-Access-Token": info.accessToken },
		});
		if (!res.ok) {
			throw new UnsupportedError(
				`envd in sandbox ${sandboxId} does not report metrics (HTTP ${res.status})`,
			);
		}
		const m = (await res.json()) as Record<string, number>;
		const ts = m.ts ?? Math.floor(Date.now() / 1000);
		return [
			{
				timestamp: new Date(ts * 1000).toISOString(),
				timestampUnix: ts,
				cpuCount: m.cpu_count ?? 0,
				cpuUsedPct: m.cpu_used_pct ?? 0,
				memUsed: m.mem_used ?? 0,
				memTotal: m.mem_total ?? 0,
				memCache: m.mem_cache ?? 0,
				diskUsed: m.disk_used ?? 0,
				diskTotal: m.disk_total ?? 0,
			},
		];
	}

	async setTimeout(sandboxId: string, timeoutSec: number): Promise<void> {
		sandboxId = await this.canonical(sandboxId);
		const timeout = this.timeoutWithinLimit(timeoutSec, 0);
		const found = await this.locate(sandboxId);
		if (!found) {
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		}
		if (this.pauses.has(sandboxId) || found.info.state !== "running") {
			throw new ConflictError(`Sandbox ${sandboxId} is paused or pausing`);
		}
		await found.backend.refreshTimeout?.(sandboxId, timeout);
		this.ttl.update(sandboxId, timeout, () => this.expire(sandboxId));
	}

	/**
	 * Extends a running sandbox to at least `durationSec` from now; never
	 * shortens it (POST /sandboxes/{id}/refreshes).
	 */
	async refresh(sandboxId: string, durationSec: number): Promise<void> {
		sandboxId = await this.canonical(sandboxId);
		const duration = this.timeoutWithinLimit(durationSec, 0);
		const found = await this.locate(sandboxId);
		if (!found) {
			throw new NotFoundError(
				`Sandbox ${sandboxId} doesn't exist or you don't have access to it`,
			);
		}
		const { info } = found;
		if (info.state !== "running") {
			throw new ConflictError(`Sandbox ${sandboxId} is paused`);
		}
		const remaining =
			(new Date(info.createdAt).getTime() +
				info.timeoutSec * 1000 -
				Date.now()) /
			1000;
		if (duration > remaining) {
			await found.backend.refreshTimeout?.(sandboxId, duration);
			this.ttl.update(sandboxId, duration, () => this.expire(sandboxId));
		}
	}

	/**
	 * Re-arms timeouts for running sandboxes from persisted state, for example
	 * after a restart. Expired ones are handled now; paused ones have none.
	 */
	async reconcile(): Promise<number> {
		const results = await Promise.all(
			this.allBackends.map((b) => b.listSandboxes({ state: "running" })),
		);
		const sandboxes = results.flat();
		for (const sb of sandboxes) {
			const remaining =
				(new Date(sb.createdAt).getTime() + sb.timeoutSec * 1000 - Date.now()) /
				1000;
			if (remaining <= 0) {
				await this.expire(sb.sandboxId);
			} else {
				this.ttl.start(sb.sandboxId, remaining, () =>
					this.expire(sb.sandboxId),
				);
			}
		}
		return sandboxes.length;
	}

	/** Sandboxes matching every given state and metadata pair, newest first, as E2B lists them. */
	async list(
		filters: {
			state?: string | string[];
			metadata?: Record<string, string>;
			template?: string;
			startedAfter?: string;
		} = {},
	) {
		const states = new Set(
			[filters.state ?? []]
				.flat()
				.filter((s) => s === "running" || s === "paused"),
		);
		const results = await Promise.all(
			this.allBackends.map(async (backend) =>
				(await backend.listSandboxes()).map((info) => ({ info, backend })),
			),
		);
		const matching = results
			.flat()
			.filter(({ info }) => states.size === 0 || states.has(info.state))
			.filter(({ info }) =>
				Object.entries(filters.metadata ?? {}).every(
					([key, value]) => info.metadata?.[key] === value,
				),
			)
			.filter(
				({ info }) =>
					!filters.template ||
					templateName(info.templateId) === templateName(filters.template),
			)
			.filter(
				({ info }) =>
					!filters.startedAfter ||
					Date.parse(info.createdAt) >= Date.parse(filters.startedAfter),
			)
			.sort(
				({ info: a }, { info: b }) =>
					b.createdAt.localeCompare(a.createdAt) ||
					a.sandboxId.localeCompare(b.sandboxId),
			);
		return Promise.all(
			matching.map(async ({ info, backend }) =>
				this.detail(info, await this.envdVersionOf(backend, info.sandboxId)),
			),
		);
	}
}

export { NotFoundError, UnsupportedError };

/** A template reference without its tag, as E2B reports the template of a sandbox. */
function templateName(templateId: string): string {
	return templateId.split(":")[0] ?? templateId;
}
