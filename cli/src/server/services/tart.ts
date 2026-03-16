import { execSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { connect } from "node:net";
import { config } from "../config.ts";
import type { SandboxInfo } from "../types.ts";
import type { ContainerBackend, CreateContainerOpts } from "./backend.ts";

interface TartInstance {
  sandboxId: string;
  vmName: string;
  hostPort: number;
  accessToken: string;
  templateId: string;
  createdAt: string;
  timeoutSec: number;
  metadata?: Record<string, string>;
  proxy?: ReturnType<typeof createServer>;
}

interface TartVm {
  name: string;
  state: string;
  // tart list --format json provides more fields but we only need these
}

function tartExec(args: string[], timeoutMs = 10_000): string {
  return execSync(`tart ${args.join(" ")}`, {
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
}

function tartList(): TartVm[] {
  try {
    const output = tartExec(["list", "--format", "json"]);
    if (!output) return [];
    const parsed = JSON.parse(output);
    // tart list --format json returns an array of objects with Source, Name, Size, State, etc.
    if (Array.isArray(parsed)) {
      return parsed.map((vm: Record<string, string>) => ({
        name: vm.Name ?? vm.name ?? "",
        state: (vm.State ?? vm.state ?? "").toLowerCase(),
      }));
    }
    return [];
  } catch {
    return [];
  }
}

function tartIp(vmName: string, waitSec = 30): string {
  return tartExec(["ip", "--wait", String(waitSec), vmName], (waitSec + 10) * 1000);
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

/** Create a TCP proxy forwarding localhost:localPort → vmIp:remotePort */
function createTcpProxy(
  localPort: number,
  remoteHost: string,
  remotePort: number,
): ReturnType<typeof createServer> {
  const server = createServer((clientSocket: Socket) => {
    const upstream = connect(remotePort, remoteHost);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });
  server.listen(localPort);
  return server;
}

export class TartBackend implements ContainerBackend {
  readonly type = "tart" as const;
  readonly supportsPause = true;
  private instances = new Map<string, TartInstance>();

  async resolveImage(templateId: string): Promise<string> {
    const imageName =
      templateId === "base" ? "sandbox-base" : `sandbox-${templateId}`;

    const vms = tartList();
    if (vms.some((vm) => vm.name === imageName)) {
      return imageName;
    }

    throw new Error(
      `Template "${templateId}" not found. No tart VM "${imageName}" exists.\n` +
        `Create one with: tart clone <source> ${imageName}`,
    );
  }

  async createContainer(
    opts: CreateContainerOpts,
  ): Promise<{ instanceId: string; hostPort: number }> {
    const image = await this.resolveImage(opts.templateId);
    const vmName = `sandbox-${opts.sandboxId}`;

    // Clone the template VM (can take a while for large macOS images)
    tartExec(["clone", image, vmName], 120_000);

    // Start the VM in the background
    const proc = Bun.spawn(["tart", "run", vmName, "--no-graphics"], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    // Wait for VM to boot and get its IP
    let vmIp: string | undefined;
    for (let i = 0; i < 4; i++) {
      try {
        vmIp = tartIp(vmName, 30);
        if (vmIp) break;
      } catch {
        // VM not ready yet, retry
      }
    }

    if (!vmIp) {
      // Cleanup on failure
      try {
        tartExec(["stop", vmName]);
      } catch {}
      try {
        tartExec(["delete", vmName]);
      } catch {}
      throw new Error(
        `Tart VM "${vmName}" failed to obtain an IP address within 60s`,
      );
    }

    // Wait for envd-lite to become healthy (pre-installed in base image via LaunchAgent)
    let envdReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://${vmIp}:${config.envdPort}/health`);
        if (res.status === 204) {
          envdReady = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!envdReady) {
      try { tartExec(["stop", vmName]); } catch {}
      try { tartExec(["delete", vmName]); } catch {}
      throw new Error(
        `envd-lite in VM "${vmName}" did not become healthy within 120s. ` +
        `Ensure envd-lite is pre-installed in the base image.`,
      );
    }

    // Set up a local TCP proxy forwarding to the VM's envd port
    const hostPort = await findFreePort();
    const proxy = createTcpProxy(hostPort, vmIp, config.envdPort);

    const instance: TartInstance = {
      sandboxId: opts.sandboxId,
      vmName,
      hostPort,
      accessToken: opts.accessToken,
      templateId: opts.templateId,
      createdAt: new Date().toISOString(),
      timeoutSec: opts.timeoutSec,
      metadata: opts.metadata,
      proxy,
    };
    this.instances.set(opts.sandboxId, instance);

    return { instanceId: vmName, hostPort };
  }

  async startContainer(sandboxId: string): Promise<{ hostPort: number }> {
    const instance = this.instances.get(sandboxId);
    if (!instance) {
      throw new Error(`Sandbox "${sandboxId}" not found`);
    }

    // Check if VM is already running
    const vms = tartList();
    const vm = vms.find((v) => v.name === instance.vmName);

    if (vm?.state === "running") {
      return { hostPort: instance.hostPort };
    }

    // Resume stopped/suspended VM
    const proc = Bun.spawn(["tart", "run", instance.vmName, "--no-graphics"], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    // Wait for IP
    let vmIp: string | undefined;
    for (let i = 0; i < 4; i++) {
      try {
        vmIp = tartIp(instance.vmName, 30);
        if (vmIp) break;
      } catch {}
    }

    if (!vmIp) {
      throw new Error(`VM "${instance.vmName}" failed to get IP on resume`);
    }

    // Recreate TCP proxy
    instance.proxy?.close();
    const hostPort = await findFreePort();
    instance.proxy = createTcpProxy(hostPort, vmIp, config.envdPort);
    instance.hostPort = hostPort;

    return { hostPort };
  }

  async stopContainer(sandboxId: string): Promise<boolean> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return false;

    instance.proxy?.close();
    instance.proxy = undefined;

    try {
      tartExec(["stop", instance.vmName]);
    } catch {
      // already stopped
    }

    return true;
  }

  async removeContainer(sandboxId: string): Promise<boolean> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return false;

    instance.proxy?.close();
    instance.proxy = undefined;

    try {
      tartExec(["stop", instance.vmName]);
    } catch {}

    try {
      tartExec(["delete", instance.vmName]);
    } catch {}

    this.instances.delete(sandboxId);
    return true;
  }

  async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
    const instance = this.instances.get(sandboxId);
    if (!instance) return null;

    const vms = tartList();
    const vm = vms.find((v) => v.name === instance.vmName);

    if (!vm) {
      this.instances.delete(sandboxId);
      return null;
    }

    const state: "running" | "paused" =
      vm.state === "running" ? "running" : "paused";

    return {
      sandboxId: instance.sandboxId,
      instanceId: instance.vmName,
      accessToken: instance.accessToken,
      templateId: instance.templateId,
      createdAt: instance.createdAt,
      timeoutSec: instance.timeoutSec,
      hostPort: instance.hostPort,
      state,
      metadata: instance.metadata,
    };
  }

  async listSandboxes(
    filters?: { state?: "running" | "paused" },
  ): Promise<SandboxInfo[]> {
    const vms = tartList();
    const vmMap = new Map(vms.map((vm) => [vm.name, vm]));
    const results: SandboxInfo[] = [];
    const dead: string[] = [];

    for (const [id, instance] of this.instances) {
      const vm = vmMap.get(instance.vmName);
      if (!vm) {
        dead.push(id);
        continue;
      }

      const state: "running" | "paused" =
        vm.state === "running" ? "running" : "paused";

      if (filters?.state && filters.state !== state) continue;

      results.push({
        sandboxId: instance.sandboxId,
        instanceId: instance.vmName,
        accessToken: instance.accessToken,
        templateId: instance.templateId,
        createdAt: instance.createdAt,
        timeoutSec: instance.timeoutSec,
        hostPort: instance.hostPort,
        state,
        metadata: instance.metadata,
      });
    }

    for (const id of dead) {
      this.instances.delete(id);
    }

    return results;
  }
}
