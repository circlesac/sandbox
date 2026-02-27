import type { SandboxInfo } from "../types.ts";
import { DockerService } from "./docker.ts";
import { ShuruBackend } from "./shuru.ts";

export type BackendType = "docker" | "shuru";

export interface CreateContainerOpts {
  sandboxId: string;
  accessToken: string;
  templateId: string;
  timeoutSec: number;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface ContainerBackend {
  readonly type: BackendType;

  resolveImage(templateId: string): Promise<string>;

  createContainer(
    opts: CreateContainerOpts,
  ): Promise<{ instanceId: string; hostPort: number }>;

  startContainer(sandboxId: string): Promise<{ hostPort: number }>;

  stopContainer(sandboxId: string): Promise<boolean>;

  removeContainer(sandboxId: string): Promise<boolean>;

  inspectSandbox(sandboxId: string): Promise<SandboxInfo | null>;

  listSandboxes(
    filters?: { state?: "running" | "paused" },
  ): Promise<SandboxInfo[]>;
}

export function createBackend(
  type: BackendType,
  opts: { dockerSocket?: string },
): ContainerBackend {
  switch (type) {
    case "docker":
      return new DockerService({
        socketPath: opts.dockerSocket ?? "/var/run/docker.sock",
      });
    case "shuru":
      return new ShuruBackend();
    default:
      throw new Error(`Unknown backend: ${type satisfies never}`);
  }
}
