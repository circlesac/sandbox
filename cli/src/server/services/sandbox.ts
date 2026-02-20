import { config } from "../config.ts";
import { generateAccessToken, generateSandboxId } from "../lib/id.ts";
import type { DockerService } from "./docker.ts";
import type { EnvdService } from "./envd.ts";
import { registerToken, clearPortCache } from "./proxy.ts";
import type { TtlService } from "./ttl.ts";

export class SandboxService {
  constructor(
    private docker: DockerService,
    private envd: EnvdService,
    private ttl: TtlService,
  ) {}

  async create(req: { templateID?: string; timeout?: number; envVars?: Record<string, string>; metadata?: Record<string, string> }) {
    const sandboxId = generateSandboxId();
    const accessToken = generateAccessToken();
    const templateId = req.templateID ?? "base";
    const timeoutSec = Math.min(
      req.timeout ?? config.defaultTimeoutSec,
      config.maxTimeoutSec,
    );

    const { hostPort } = await this.docker.createContainer({
      sandboxId,
      accessToken,
      templateId,
      timeoutSec,
      envVars: req.envVars,
      metadata: req.metadata,
    });

    try {
      await this.envd.waitForHealth(hostPort);
      await this.envd.init(hostPort, {
        accessToken,
        envVars: req.envVars,
      });
    } catch (err) {
      await this.docker.removeContainer(sandboxId);
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
    const info = await this.docker.inspectSandbox(sandboxId);
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
    return this.docker.removeContainer(sandboxId);
  }

  async pause(sandboxId: string): Promise<boolean> {
    this.ttl.clear(sandboxId);
    return this.docker.stopContainer(sandboxId);
  }

  async connect(
    sandboxId: string,
    timeoutSec?: number,
  ) {
    const info = await this.docker.inspectSandbox(sandboxId);
    if (!info) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`);
    }

    const { hostPort } = await this.docker.startContainer(sandboxId);

    await this.envd.waitForHealth(hostPort);
    await this.envd.init(hostPort, {
      accessToken: info.accessToken,
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
    const info = await this.docker.inspectSandbox(sandboxId);
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
    const sandboxes = await this.docker.listSandboxes({ state });
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
