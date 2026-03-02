import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { config } from "../config.ts";
import type { SandboxInfo } from "../types.ts";
import type { ContainerBackend, CreateContainerOpts } from "./backend.ts";

interface ShruInstance {
  sandboxId: string;
  pid: number;
  hostPort: number;
  accessToken: string;
  templateId: string;
  createdAt: string;
  timeoutSec: number;
  metadata?: Record<string, string>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function listCheckpoints(): string[] {
  try {
    const output = execSync("shuru checkpoint list", {
      encoding: "utf-8",
      timeout: 5000,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export class ShuruBackend implements ContainerBackend {
  readonly type = "shuru" as const;
  readonly supportsPause = false;
  private instances = new Map<string, ShruInstance>();

  async resolveImage(templateId: string): Promise<string> {
    const checkpointName =
      templateId === "base" ? "sandbox-base" : `sandbox-${templateId}`;

    const checkpoints = listCheckpoints();
    if (checkpoints.some((c) => c.includes(checkpointName))) {
      return checkpointName;
    }

    // If "base" template requested and no checkpoint, try running without --from
    if (templateId === "base") {
      return "";
    }

    throw new Error(
      `Template "${templateId}" not found. No shuru checkpoint "${checkpointName}" exists.\n` +
        `Create one with: shuru checkpoint create ${checkpointName} --allow-net -- sh -c 'apk add ...'`,
    );
  }

  async createContainer(
    opts: CreateContainerOpts,
  ): Promise<{ instanceId: string; hostPort: number }> {
    const image = await this.resolveImage(opts.templateId);
    const hostPort = await findFreePort();

    const args = ["shuru", "run"];
    if (image) {
      args.push("--from", image);
    }
    args.push("-p", `${hostPort}:${config.envdPort}`);
    args.push("--allow-net");
    args.push("--", "envd", "-isnotfc");

    const proc = Bun.spawn(args, {
      stdio: ["ignore", "ignore", "ignore"],
    });

    const instance: ShruInstance = {
      sandboxId: opts.sandboxId,
      pid: proc.pid,
      hostPort,
      accessToken: opts.accessToken,
      templateId: opts.templateId,
      createdAt: new Date().toISOString(),
      timeoutSec: opts.timeoutSec,
      metadata: opts.metadata,
    };
    this.instances.set(opts.sandboxId, instance);

    return { instanceId: String(proc.pid), hostPort };
  }

  async startContainer(_sandboxId: string): Promise<{ hostPort: number }> {
    const instance = this.instances.get(_sandboxId);
    if (instance && isProcessAlive(instance.pid)) {
      return { hostPort: instance.hostPort };
    }

    throw new Error(
      `Cannot resume shuru sandbox "${_sandboxId}". Shuru VMs are ephemeral — ` +
        "once stopped, the VM is destroyed. Create a new sandbox instead.",
    );
  }

  async stopContainer(sandboxId: string): Promise<boolean> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return false;

    if (isProcessAlive(instance.pid)) {
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch {
        // already dead
      }
    }

    this.instances.delete(sandboxId);
    return true;
  }

  async removeContainer(sandboxId: string): Promise<boolean> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return false;

    if (isProcessAlive(instance.pid)) {
      try {
        process.kill(instance.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }

    this.instances.delete(sandboxId);
    return true;
  }

  async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return null;

    if (!isProcessAlive(instance.pid)) {
      this.instances.delete(sandboxId);
      return null;
    }

    return {
      sandboxId: instance.sandboxId,
      instanceId: String(instance.pid),
      accessToken: instance.accessToken,
      templateId: instance.templateId,
      createdAt: instance.createdAt,
      timeoutSec: instance.timeoutSec,
      hostPort: instance.hostPort,
      state: "running",
      metadata: instance.metadata,
    };
  }

  async listSandboxes(
    filters?: { state?: "running" | "paused" },
  ): Promise<SandboxInfo[]> {
    const results: SandboxInfo[] = [];
    const dead: string[] = [];

    for (const [id, instance] of this.instances) {
      if (!isProcessAlive(instance.pid)) {
        dead.push(id);
        continue;
      }

      // All live shuru instances are "running" — no pause support
      if (filters?.state && filters.state !== "running") continue;

      results.push({
        sandboxId: instance.sandboxId,
        instanceId: String(instance.pid),
        accessToken: instance.accessToken,
        templateId: instance.templateId,
        createdAt: instance.createdAt,
        timeoutSec: instance.timeoutSec,
        hostPort: instance.hostPort,
        state: "running",
        metadata: instance.metadata,
      });
    }

    // Clean up dead instances
    for (const id of dead) {
      this.instances.delete(id);
    }

    return results;
  }
}
