import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_API_KEY = "sk-test-shuru-integration";

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
  throw new Error(`Shuru server did not become healthy on :${port} within ${timeoutMs}ms`);
}

function isShuruAvailable(): boolean {
  const result = spawnSync("shuru", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function hasCheckpoint(): boolean {
  const result = spawnSync("shuru", ["checkpoint", "list"], { encoding: "utf-8", stdio: "pipe" });
  return result.status === 0 && (result.stdout ?? "").includes("sandbox-base");
}

const skip = !isShuruAvailable() || !hasCheckpoint();

describe.skipIf(skip)("Shuru E2B Smoke", { timeout: 180_000 }, () => {
  let serverProcess: ChildProcess | undefined;
  let opts: { apiUrl: string; apiKey: string; sandboxUrl: string };
  let sandbox: Sandbox;

  beforeAll(async () => {
    const port = await findFreePort();
    const serverEntry = join(__dirname, "..", "..", "src", "server", "index.ts");
    serverProcess = spawn("bun", ["run", serverEntry], {
      env: {
        ...process.env,
        PORT: String(port),
        API_KEYS: TEST_API_KEY,
        SANDBOX_BACKEND: "shuru",
      },
      stdio: "pipe",
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[shuru-server] ${data}`);
    });

    await waitForHealth(port);

    opts = {
      apiUrl: `http://localhost:${port}`,
      apiKey: TEST_API_KEY,
      sandboxUrl: `http://localhost:${port}`,
    };
  });

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
        sandbox.commands.run("bash -c 'exit 42'"),
      ).rejects.toThrow("exit status 42");
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

    it("whoami returns default user", async () => {
      const result = await sandbox.commands.run("whoami");
      expect(result.stdout.trim()).toBe("user");
    });
  });

  // ── Filesystem ─────────────────────────────────────────────

  describe("Filesystem", () => {
    it("writes and reads a file", async () => {
      await sandbox.files.write("/tmp/test.txt", "hello shuru");
      const content = await sandbox.files.read("/tmp/test.txt");
      expect(content).toBe("hello shuru");
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

  // ── Isolation ──────────────────────────────────────────────

  describe("Isolation", () => {
    it("has isolated filesystems between sandboxes", async () => {
      const sbA = await Sandbox.create("base", opts);
      const sbB = await Sandbox.create("base", opts);

      await sbA.files.write("/tmp/isolated.txt", "sandbox-a");
      const resultB = await sbB.commands.run("cat /tmp/isolated.txt 2>&1 || echo NOT_FOUND");
      expect(
        resultB.stdout.includes("NOT_FOUND") || resultB.stdout.includes("No such file"),
      ).toBe(true);

      await sbA.kill();
      await sbB.kill();
    });
  });

  // ── Pause (unsupported) ────────────────────────────────────

  describe("Pause", () => {
    it("returns 501 when pause is requested", async () => {
      const res = await fetch(`${opts.apiUrl}/sandboxes/${sandbox.sandboxId}/pause`, {
        method: "POST",
        headers: { "X-API-Key": opts.apiKey },
      });
      expect(res.status).toBe(501);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unsupported");
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
