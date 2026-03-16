import type { SandboxInfo } from "../types.ts";
import { DockerService } from "./docker.ts";
import { ShuruBackend } from "./shuru.ts";
import { TartBackend } from "./tart.ts";

export type BackendType = "docker" | "shuru" | "tart";
export type Platform = "linux" | "macos";

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
  readonly supportsPause: boolean;

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
    case "tart":
      return new TartBackend();
    default:
      throw new Error(`Unknown backend: ${type satisfies never}`);
  }
}

/** Map of platform → backend. Linux is required, macOS is optional. */
export interface BackendMap {
  linux: ContainerBackend;
  macos?: ContainerBackend;
}

export function createBackends(opts: {
  linux: BackendType;
  macos?: BackendType;
  dockerSocket?: string;
}): BackendMap {
  return {
    linux: createBackend(opts.linux, { dockerSocket: opts.dockerSocket }),
    macos: opts.macos
      ? createBackend(opts.macos, { dockerSocket: opts.dockerSocket })
      : undefined,
  };
}

export function resolvePlatform(
  metadata?: Record<string, string>,
): Platform {
  return metadata?.platform === "macos" ? "macos" : "linux";
}
