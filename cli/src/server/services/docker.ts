import Docker from "dockerode";
import { config } from "../config.ts";
import type { SandboxInfo, SandboxLabels } from "../types.ts";

const docker = new Docker({ socketPath: config.dockerSocket });

const REGISTRY = "ghcr.io/circlesac";

function localImageName(templateId: string) {
  return `sandbox-${templateId}:latest`;
}

function registryImageName(templateId: string) {
  return `${REGISTRY}/sandbox-${templateId}:latest`;
}

export class DockerService {
  async resolveImage(templateId: string): Promise<string> {
    const local = localImageName(templateId);
    try {
      await docker.getImage(local).inspect();
      return local;
    } catch {
      // not found locally
    }

    const remote = registryImageName(templateId);
    try {
      await new Promise<void>((resolve, reject) => {
        docker.pull(remote, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err: Error | null) =>
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

  async createContainer(opts: {
    sandboxId: string;
    accessToken: string;
    templateId: string;
    timeoutSec: number;
    envVars?: Record<string, string>;
    metadata?: Record<string, string>;
  }): Promise<{ containerId: string; hostPort: number }> {
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

    const container = await docker.createContainer({
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

    return { containerId: info.Id, hostPort };
  }

  async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
    try {
      const container = docker.getContainer(sandboxId);
      const info = await container.inspect();
      return this.parseContainerInfo(info);
    } catch (err: unknown) {
      if (isDockerNotFound(err)) return null;
      throw err;
    }
  }

  async removeContainer(sandboxId: string): Promise<boolean> {
    try {
      const container = docker.getContainer(sandboxId);
      await container.remove({ force: true });
      return true;
    } catch (err: unknown) {
      if (isDockerNotFound(err)) return false;
      throw err;
    }
  }

  async stopContainer(sandboxId: string): Promise<boolean> {
    try {
      const container = docker.getContainer(sandboxId);
      await container.stop();
      return true;
    } catch (err: unknown) {
      if (isDockerNotFound(err)) return false;
      // Already stopped
      if (isDockerNotModified(err)) return true;
      throw err;
    }
  }

  async startContainer(
    sandboxId: string,
  ): Promise<{ hostPort: number }> {
    const container = docker.getContainer(sandboxId);
    await container.start();

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

  async listSandboxes(filters?: {
    state?: "running" | "paused";
  }): Promise<SandboxInfo[]> {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["e2b.sandbox-id"] },
    });

    const results: SandboxInfo[] = [];
    for (const c of containers) {
      const sandbox = this.parseContainerListInfo(c);
      if (!sandbox) continue;
      if (filters?.state && sandbox.state !== filters.state) continue;
      results.push(sandbox);
    }
    return results;
  }

  private parseContainerInfo(info: Docker.ContainerInspectInfo): SandboxInfo {
    const labels = info.Config.Labels as unknown as SandboxLabels;
    const portBindings =
      info.NetworkSettings.Ports[`${config.envdPort}/tcp`];
    const hostPort = Number(portBindings?.[0]?.HostPort) || 0;

    return {
      sandboxId: labels["e2b.sandbox-id"] ?? info.Name.replace(/^\//, ""),
      containerId: info.Id,
      accessToken: labels["e2b.access-token"] ?? "",
      templateId: labels["e2b.template-id"] ?? "base",
      createdAt: labels["e2b.created-at"] ?? info.Created,
      timeoutSec: Number(labels["e2b.timeout"] ?? config.defaultTimeoutSec),
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
      containerId: c.Id,
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
