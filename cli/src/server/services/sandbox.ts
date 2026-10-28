import { config } from "../config.ts";
import { NotFoundError, UnsupportedError } from "../errors.ts";
import { generateAccessToken, generateSandboxId } from "../lib/id.ts";
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

	private prepare(req: CreateRequest) {
		const platform = resolvePlatform(req.metadata);
		const backend = this.backendFor(platform);
		return {
			sandboxId: generateSandboxId(),
			accessToken: generateAccessToken(),
			templateId: req.templateID ?? "base",
			timeoutSec: Math.min(
				req.timeoutSec ?? req.timeout ?? config.defaultTimeoutSec,
				config.maxTimeoutSec,
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
				envVars: req.envVars,
			});
		} catch (err) {
			await p.backend.removeContainer(p.sandboxId).catch(() => {});
			this._sandboxPlatform.delete(p.sandboxId);
			throw err;
		}

		registerToken(p.accessToken, p.sandboxId);
		this.ttl.start(p.sandboxId, p.timeoutSec, () => this.expire(p.sandboxId));
	}

	/** The token envd itself enforces; backends whose envd cannot are checked by the proxy. */
	private envdToken(
		backend: ContainerBackend,
		secure: boolean,
		accessToken: string,
	): string | undefined {
		return secure && backend.envdChecksAccessToken ? accessToken : undefined;
	}

	private response(
		p: {
			sandboxId: string;
			templateId: string;
			accessToken: string;
			lifecycle: { secure: boolean; trafficAccessToken: string | null };
		},
		ctx: RequestContext,
	) {
		return {
			sandboxID: p.sandboxId,
			templateID: p.templateId,
			clientID: p.sandboxId,
			envdVersion: config.envdVersion,
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
		return this.response(p, ctx);
	}

	async getInfo(sandboxId: string) {
		const found = await this.locate(sandboxId);
		if (!found) return null;
		return this.detail(found.info);
	}

	private detail(info: SandboxInfo) {
		return {
			sandboxID: info.sandboxId,
			templateID: info.templateId,
			clientID: info.sandboxId,
			envdVersion: config.envdVersion,
			domain: null,
			startedAt: info.createdAt,
			endAt: new Date(
				new Date(info.createdAt).getTime() + info.timeoutSec * 1000,
			).toISOString(),
			metadata: info.metadata,
			state: info.state,
		};
	}

	async kill(sandboxId: string): Promise<boolean> {
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
		const found = await this.locate(sandboxId);
		if (!found) return false;
		const { backend } = found;
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
		this.ttl.clear(sandboxId);
		clearRoutes(sandboxId);
		return backend.stopContainer(sandboxId, { keepMemory });
	}

	/** Timeout handler: pause or kill as the sandbox's lifecycle says. */
	async expire(sandboxId: string): Promise<void> {
		try {
			const found = await this.locate(sandboxId);
			if (!found || found.info.state !== "running") return;
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
		const found = await this.locate(sandboxId);
		if (!found) {
			throw new NotFoundError(`Sandbox ${sandboxId} not found`);
		}
		const { info, backend } = found;

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
		});
		registerToken(info.accessToken, sandboxId);

		// Connecting only ever extends a running sandbox's remaining time.
		const requested = Math.min(
			timeoutSec ?? config.defaultTimeoutSec,
			config.maxTimeoutSec,
		);
		const remaining =
			info.state === "running"
				? (new Date(info.createdAt).getTime() +
						info.timeoutSec * 1000 -
						Date.now()) /
					1000
				: 0;
		const timeout = Math.max(requested, Math.ceil(remaining));
		await backend.refreshTimeout?.(sandboxId, timeout);
		this.ttl.start(sandboxId, timeout, () => this.expire(sandboxId));

		return this.response(
			{
				sandboxId: info.sandboxId,
				templateId: info.templateId,
				accessToken: info.accessToken,
				lifecycle: info.lifecycle,
			},
			ctx,
		);
	}

	/**
	 * Resumes a paused sandbox for proxied traffic when its lifecycle allows it.
	 * Concurrent requests share one resume. Returns whether the sandbox runs.
	 */
	async resumeForTraffic(sandboxId: string): Promise<boolean> {
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

	async setTimeout(sandboxId: string, timeoutSec: number): Promise<void> {
		const found = await this.locate(sandboxId);
		if (!found) {
			throw new NotFoundError(`Sandbox ${sandboxId} not found`);
		}

		const clamped = Math.min(timeoutSec, config.maxTimeoutSec);
		await found.backend.refreshTimeout?.(sandboxId, clamped);
		this.ttl.update(sandboxId, clamped, () => this.expire(sandboxId));
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

	async list(filters?: { state?: string; metadata?: Record<string, string> }) {
		const state =
			filters?.state === "running" || filters?.state === "paused"
				? filters.state
				: undefined;

		const results = await Promise.all(
			this.allBackends.map((b) => b.listSandboxes({ state })),
		);
		return results.flat().map((info) => this.detail(info));
	}
}

export { NotFoundError, UnsupportedError };
