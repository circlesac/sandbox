import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_API_KEY = "sk-test-tart-integration";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 30_000) {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Tart server did not become healthy on :${port} within ${timeoutMs}ms`);
}

function isTartAvailable(): boolean {
  const result = spawnSync("tart", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function hasSandboxBaseVM(): boolean {
  const result = spawnSync("tart", ["list", "--format", "json"], { encoding: "utf-8", stdio: "pipe" });
  if (result.status !== 0) return false;
  try {
    const vms = JSON.parse(result.stdout ?? "[]");
    return Array.isArray(vms) && vms.some((vm: { Name?: string; name?: string }) => (vm.Name ?? vm.name) === "sandbox-base");
  } catch {
    return false;
  }
}

const skip = !isTartAvailable() || !hasSandboxBaseVM();

describe.skipIf(skip)("Tart E2B Smoke", { timeout: 600_000 }, () => {
  let serverProcess: ChildProcess | undefined;
  let opts: { apiUrl: string; apiKey: string; sandboxUrl: string; requestTimeoutMs: number; metadata: Record<string, string> };
  let sandbox: Sandbox;

  beforeAll(async () => {
    const port = await findFreePort();
    const envdProxyPort = await findFreePort();
    const serverEntry = join(__dirname, "..", "..", "src", "server", "index.ts");
    serverProcess = spawn("bun", ["run", serverEntry], {
      env: {
        ...process.env,
        PORT: String(port),
        ENVD_PROXY_PORT: String(envdProxyPort),
        API_KEYS: TEST_API_KEY,
        SANDBOX_MACOS_BACKEND: "tart",
      },
      stdio: "pipe",
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[tart-server] ${data}`);
    });

    await waitForHealth(port, 60_000);

    opts = {
      apiUrl: `http://localhost:${port}`,
      apiKey: TEST_API_KEY,
      sandboxUrl: `http://localhost:${port}`,
      requestTimeoutMs: 600_000,
      metadata: { platform: "macos" },
    };
  }, 120_000);

  afterAll(async () => {
    try {
      const paginator = Sandbox.list(opts);
      const all = await paginator.nextItems();
      await Promise.allSettled(all.map((s) => Sandbox.kill(s.sandboxId, opts)));
    } catch {
      // best-effort cleanup
    }
    serverProcess?.kill("SIGTERM");
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe("Lifecycle", () => {
    it("creates a sandbox", async () => {
      sandbox = await Sandbox.create("base", opts);
      expect(sandbox.sandboxId).toMatch(/^sbx-/);
    });

    it("lists sandboxes and includes the created one", async () => {
      const paginator = Sandbox.list(opts);
      const sandboxes = await paginator.nextItems();
      const found = sandboxes.find((s) => s.sandboxId === sandbox.sandboxId);
      expect(found).toBeDefined();
    });
  });

  // ── Commands ───────────────────────────────────────────────

  describe("Commands", () => {
    it("runs echo command", async () => {
      const result = await sandbox.commands.run("echo hello world");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
    });

    it("handles non-zero exit code", async () => {
      await expect(
        sandbox.commands.run("exit 42"),
      ).rejects.toThrow();
    });

    it("captures stderr", async () => {
      const result = await sandbox.commands.run("echo error >&2");
      expect(result.stderr.trim()).toBe("error");
    });

    it("passes env vars", async () => {
      const result = await sandbox.commands.run("echo $FOO", { envs: { FOO: "bar" } });
      expect(result.stdout.trim()).toBe("bar");
    });

    it("runs long-running command", async () => {
      const result = await sandbox.commands.run("sleep 1 && echo done");
      expect(result.stdout.trim()).toBe("done");
    });

    it("whoami returns admin", async () => {
      const result = await sandbox.commands.run("whoami");
      expect(result.stdout.trim()).toBe("admin");
    });
  });

  // ── Filesystem ─────────────────────────────────────────────

  describe("Filesystem", () => {
    it("writes and reads a file", async () => {
      await sandbox.files.write("/tmp/test.txt", "hello tart");
      const content = await sandbox.files.read("/tmp/test.txt");
      expect(content).toBe("hello tart");
    });

    it("lists directory entries", async () => {
      await sandbox.commands.run("mkdir -p /tmp/testdir && touch /tmp/testdir/a.txt /tmp/testdir/b.txt");
      const entries = await sandbox.files.list("/tmp/testdir");
      const names = entries.map((e) => e.name).sort();
      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
    });

    it("reads file created by shell command via SDK", async () => {
      await sandbox.commands.run("echo -n 'from-cmd' > /tmp/cmd-file.txt");
      const content = await sandbox.files.read("/tmp/cmd-file.txt");
      expect(content).toBe("from-cmd");
    });
  });

  // ── Cleanup ────────────────────────────────────────────────

  describe("Cleanup", () => {
    it("kills the sandbox", async () => {
      await sandbox.kill();
    });

    it("sandbox is no longer in the list after kill", async () => {
      const paginator = Sandbox.list(opts);
      const sandboxes = await paginator.nextItems();
      const found = sandboxes.find((s) => s.sandboxId === sandbox.sandboxId);
      expect(found).toBeUndefined();
    });
  });
});
