import { config } from "../config.ts";
import { generateAccessToken, generateSandboxId } from "../lib/id.ts";
import { resolvePlatform, type BackendMap, type ContainerBackend, type Platform } from "./backend.ts";
import type { EnvdService } from "./envd.ts";
import { registerToken, clearPortCache } from "./proxy.ts";
import type { TtlService } from "./ttl.ts";

export class SandboxService {
  constructor(
    private backends: BackendMap,
    private envd: EnvdService,
    private ttl: TtlService,
  ) {}

  /** Single backend for backwards compat (proxy, TTL reconciliation). */
  get backend(): ContainerBackend {
    return this.backends.linux;
  }

  private backendFor(platform: Platform): ContainerBackend {
    const b = this.backends[platform];
    if (!b) {
      throw new UnsupportedError(`No backend configured for platform "${platform}"`);
    }
    return b;
  }

  private backendForSandbox(sandboxId: string): ContainerBackend {
    // Check all backends for this sandbox
    // We rely on the sandboxId being unique across backends
    return this._sandboxPlatform.get(sandboxId)
      ? this.backendFor(this._sandboxPlatform.get(sandboxId)!)
      : this.backends.linux;
  }

  // Track which platform each sandbox belongs to
  private _sandboxPlatform = new Map<string, Platform>();

  /**
   * Async create — returns sandbox ID immediately, boots VM in background.
   * Caller should poll GET /sandboxes/:id to check when ready.
   */
  async createAsync(req: { templateID?: string; timeout?: number; timeoutSec?: number; envVars?: Record<string, string>; metadata?: Record<string, string> }) {
    const sandboxId = generateSandboxId();
    const accessToken = generateAccessToken();
    const templateId = req.templateID ?? "base";
    const timeoutSec = Math.min(
      req.timeoutSec ?? req.timeout ?? config.defaultTimeoutSec,
      config.maxTimeoutSec,
    );
    const platform = resolvePlatform(req.metadata);
    const backend = this.backendFor(platform);

    this._sandboxPlatform.set(sandboxId, platform);
    registerToken(accessToken, sandboxId);

    // Boot in background
    (async () => {
      try {
        const { hostPort } = await backend.createContainer({
          sandboxId,
          accessToken,
          templateId,
          timeoutSec,
          envVars: req.envVars,
          metadata: req.metadata,
        });

        await this.envd.waitForHealth(hostPort);
        await this.envd.init(hostPort, {
          accessToken: backend.type === "docker" ? accessToken : undefined,
          envVars: req.envVars,
        });

        // If JIT_CONFIG envVar is set, write it to /tmp/jitconfig for the runner LaunchAgent
        if (req.envVars?.JIT_CONFIG) {
          try {
            await fetch(`http://localhost:${hostPort}/files?path=/tmp/jitconfig`, {
              method: "POST",
              body: req.envVars.JIT_CONFIG,
            });
            console.log(`[async] Wrote /tmp/jitconfig to sandbox ${sandboxId}`);
          } catch (err) {
            console.error(`[async] Failed to write jitconfig:`, err);
          }
        }

        this.ttl.start(sandboxId, timeoutSec, () => {
          this.kill(sandboxId).catch(console.error);
        });

        console.log(`[async] Sandbox ${sandboxId} ready`);
      } catch (err) {
        console.error(`[async] Sandbox ${sandboxId} failed:`, err);
        await backend.removeContainer(sandboxId).catch(() => {});
        this._sandboxPlatform.delete(sandboxId);
      }
    })();

    return {
      sandboxID: sandboxId,
      templateID: templateId,
      clientID: sandboxId,
      envdVersion: config.envdVersion,
      envdAccessToken: accessToken,
      trafficAccessToken: null,
      domain: null,
    };
  }

  async create(req: { templateID?: string; timeout?: number; timeoutSec?: number; envVars?: Record<string, string>; metadata?: Record<string, string> }) {
    const sandboxId = generateSandboxId();
    const accessToken = generateAccessToken();
    const templateId = req.templateID ?? "base";
    const timeoutSec = Math.min(
      req.timeoutSec ?? req.timeout ?? config.defaultTimeoutSec,
      config.maxTimeoutSec,
    );
    const platform = resolvePlatform(req.metadata);
    const backend = this.backendFor(platform);

    const { hostPort } = await backend.createContainer({
      sandboxId,
      accessToken,
      templateId,
      timeoutSec,
      envVars: req.envVars,
      metadata: req.metadata,
    });

    this._sandboxPlatform.set(sandboxId, platform);

    try {
      await this.envd.waitForHealth(hostPort);
      await this.envd.init(hostPort, {
        accessToken: backend.type === "docker" ? accessToken : undefined,
        envVars: req.envVars,
      });
    } catch (err) {
      await backend.removeContainer(sandboxId);
      this._sandboxPlatform.delete(sandboxId);
      throw err;
    }

    registerToken(accessToken, sandboxId);

    this.ttl.start(sandboxId, timeoutSec, () => {
      this.kill(sandboxId).catch(console.error);
    });

    return {
      sandboxID: sandboxId,
      templateID: templateId,
      clientID: sandboxId,
      envdVersion: config.envdVersion,
      envdAccessToken: accessToken,
      trafficAccessToken: null,
      domain: null,
    };
  }

  async getInfo(sandboxId: string) {
    const backend = this.backendForSandbox(sandboxId);
    const info = await backend.inspectSandbox(sandboxId);
    if (!info) return null;

    const endAt = new Date(
      new Date(info.createdAt).getTime() + info.timeoutSec * 1000,
    ).toISOString();

    return {
      sandboxID: info.sandboxId,
      templateID: info.templateId,
      clientID: info.sandboxId,
      envdVersion: config.envdVersion,
      domain: null,
      startedAt: info.createdAt,
      endAt,
      metadata: info.metadata,
    };
  }

  async kill(sandboxId: string): Promise<boolean> {
    this.ttl.clear(sandboxId);
    clearPortCache(sandboxId);
    const backend = this.backendForSandbox(sandboxId);
    const result = await backend.removeContainer(sandboxId);
    this._sandboxPlatform.delete(sandboxId);
    return result;
  }

  async pause(sandboxId: string): Promise<boolean> {
    const backend = this.backendForSandbox(sandboxId);
    if (!backend.supportsPause) {
      throw new UnsupportedError(
        `Pause is not supported by the ${backend.type} backend`,
      );
    }
    this.ttl.clear(sandboxId);
    clearPortCache(sandboxId);
    return backend.stopContainer(sandboxId);
  }

  async connect(
    sandboxId: string,
    timeoutSec?: number,
  ) {
    const backend = this.backendForSandbox(sandboxId);
    const info = await backend.inspectSandbox(sandboxId);
    if (!info) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`);
    }

    const { hostPort } = await backend.startContainer(sandboxId);

    await this.envd.waitForHealth(hostPort);
    await this.envd.init(hostPort, {
      accessToken: backend.type === "docker" ? info.accessToken : undefined,
      envVars: info.metadata ? undefined : undefined,
    });

    const timeout = Math.min(
      timeoutSec ?? config.defaultTimeoutSec,
      config.maxTimeoutSec,
    );
    this.ttl.start(sandboxId, timeout, () => {
      this.kill(sandboxId).catch(console.error);
    });

    return {
      sandboxID: info.sandboxId,
      templateID: info.templateId,
      clientID: info.sandboxId,
      envdVersion: config.envdVersion,
      envdAccessToken: info.accessToken,
      trafficAccessToken: null,
      domain: null,
    };
  }

  async setTimeout(sandboxId: string, timeoutSec: number): Promise<void> {
    const backend = this.backendForSandbox(sandboxId);
    const info = await backend.inspectSandbox(sandboxId);
    if (!info) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`);
    }

    const clamped = Math.min(timeoutSec, config.maxTimeoutSec);
    this.ttl.update(sandboxId, clamped, () => {
      this.kill(sandboxId).catch(console.error);
    });
  }

  async list(filters?: {
    state?: string;
    metadata?: Record<string, string>;
  }) {
    const state =
      filters?.state === "running" || filters?.state === "paused"
        ? filters.state
        : undefined;

    const allBackends = [this.backends.linux, this.backends.macos].filter(
      (b): b is ContainerBackend => b != null,
    );
    const results = await Promise.all(
      allBackends.map((b) => b.listSandboxes({ state })),
    );
    const sandboxes = results.flat();

    return sandboxes.map((info) => ({
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
    }));
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}
