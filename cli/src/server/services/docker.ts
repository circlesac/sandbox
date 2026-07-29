import Docker from "dockerode";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import type { SandboxInfo, SandboxLabels } from "../types.ts";
import type { ContainerBackend, CreateContainerOpts } from "./backend.ts";

const REGISTRY = "ghcr.io/circlesac";

function localImageName(templateId: string) {
  return `sandbox-${templateId}:latest`;
}

function registryImageName(templateId: string) {
  return `${REGISTRY}/sandbox-${templateId}:latest`;
}

interface DockerTimeoutState {
  startedAt: string;
  timeoutSec: number;
}

export class DockerService implements ContainerBackend {
  readonly type = "docker" as const;
  readonly supportsPause = true;
  private docker: Docker;
  private timeoutState = new Map<string, DockerTimeoutState>();
  private timeoutStatePath: string | null;

  constructor(opts: { socketPath: string; statePath?: string | null }) {
    this.docker = new Docker({ socketPath: opts.socketPath });
    this.timeoutStatePath = opts.statePath === undefined
      ? join(homedir(), ".sandbox", "docker-timeouts.json")
      : opts.statePath;
    this.loadTimeoutState();
  }

  async resolveImage(templateId: string): Promise<string> {
    const local = localImageName(templateId);
    try {
      await this.docker.getImage(local).inspect();
      return local;
    } catch {
      // not found locally
    }

    const remote = registryImageName(templateId);
    try {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(remote, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err: Error | null) =>
            err ? reject(err) : resolve(),
          );
        });
      });
      return remote;
    } catch {
      throw new Error(
        `Template "${templateId}" not found. Checked:\n  - ${local}\n  - ${remote}`,
      );
    }
  }

  async createContainer(
    opts: CreateContainerOpts,
  ): Promise<{ instanceId: string; hostPort: number }> {
    const image = await this.resolveImage(opts.templateId);

    const labels: Record<string, string> = {
      "e2b.sandbox-id": opts.sandboxId,
      "e2b.access-token": opts.accessToken,
      "e2b.template-id": opts.templateId,
      "e2b.created-at": new Date().toISOString(),
      "e2b.timeout": String(opts.timeoutSec),
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
    const portBindings =
      info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
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
      return this.parseContainerInfo(info);
    } catch (err: unknown) {
      if (isDockerNotFound(err)) return null;
      throw err;
    }
  }

  async removeContainer(sandboxId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(sandboxId);
      await container.remove({ force: true });
    } catch (err: unknown) {
      if (!isDockerNotFound(err)) throw err;
      this.clearTimeoutState(sandboxId);
      return false;
    }
    this.clearTimeoutState(sandboxId);
    return true;
  }

  async stopContainer(sandboxId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(sandboxId);
      await container.stop();
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

  async startContainer(
    sandboxId: string,
  ): Promise<{ hostPort: number }> {
    const container = this.docker.getContainer(sandboxId);
    try {
      await container.start();
    } catch (err: unknown) {
      if (!isDockerNotModified(err)) throw err;
    }

    const info = await container.inspect();
    const portBindings =
      info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
    const hostPort = Number(portBindings?.[0]?.HostPort);

    if (!hostPort) {
      throw new Error(
        `Failed to get host port after starting ${sandboxId}`,
      );
    }

    return { hostPort };
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

      let sandbox: SandboxInfo | null;
      try {
        sandbox = c.State === "running"
          ? await this.docker.getContainer(c.Id).inspect().then((info) => this.parseContainerInfo(info))
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
    const portBindings =
      info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
    const hostPort = Number(portBindings?.[0]?.HostPort) || 0;
    const sandboxId = labels["e2b.sandbox-id"] ?? info.Name.replace(/^\//, "");
    const timeout = info.State.Running
      ? this.timeoutState.get(sandboxId)
      : undefined;

    return {
      sandboxId,
      instanceId: info.Id,
      accessToken: labels["e2b.access-token"] ?? "",
      templateId: labels["e2b.template-id"] ?? "base",
      createdAt: info.State.Running
        ? timeout?.startedAt ?? info.State.StartedAt
        : labels["e2b.created-at"] ?? info.Created,
      timeoutSec: timeout?.timeoutSec
        ?? Number(labels["e2b.timeout"] ?? config.defaultTimeoutSec),
      hostPort,
      state: info.State.Running ? "running" : "paused",
      metadata: labels["e2b.metadata"]
        ? JSON.parse(labels["e2b.metadata"])
        : undefined,
    };
  }

  private parseContainerListInfo(
    c: Docker.ContainerInfo,
  ): SandboxInfo | null {
    const labels = c.Labels as unknown as SandboxLabels;
    if (!labels["e2b.sandbox-id"]) return null;

    const portMapping = c.Ports.find(
      (p) => p.PrivatePort === config.envdPort,
    );

    return {
      sandboxId: labels["e2b.sandbox-id"],
      instanceId: c.Id,
      accessToken: labels["e2b.access-token"] ?? "",
      templateId: labels["e2b.template-id"] ?? "base",
      createdAt: labels["e2b.created-at"] ?? "",
      timeoutSec: Number(labels["e2b.timeout"] ?? config.defaultTimeoutSec),
      hostPort: portMapping?.PublicPort ?? 0,
      state: c.State === "running" ? "running" : "paused",
      metadata: labels["e2b.metadata"]
        ? JSON.parse(labels["e2b.metadata"])
        : undefined,
    };
  }

  private loadTimeoutState(): void {
    if (!this.timeoutStatePath || !existsSync(this.timeoutStatePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.timeoutStatePath, "utf8"));
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
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
