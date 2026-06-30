import { existsSync, readFileSync } from "node:fs";
import { Sandbox } from "e2b";
import { describe, it, expect, afterAll } from "vitest";

const SERVER_INFO_PATH = "/tmp/sandbox-integration-test.json";

function loadServerInfo(): { port: number; apiKey: string } | null {
  if (!existsSync(SERVER_INFO_PATH)) return null;
  return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));
}

const serverInfo = loadServerInfo();

const opts = serverInfo
  ? {
      apiUrl: `http://localhost:${serverInfo.port}`,
      apiKey: serverInfo.apiKey,
      sandboxUrl: `http://localhost:${serverInfo.port}`,
    }
  : undefined;

describe.skipIf(!opts)("E2B Smoke", { timeout: 120_000 }, () => {
  let sandbox: Sandbox;

  afterAll(async () => {
    try {
      const paginator = Sandbox.list(opts!);
      const all = await paginator.nextItems();
      await Promise.allSettled(all.map((s) => Sandbox.kill(s.sandboxId, opts!)));
    } catch {
      // best-effort cleanup
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe("Lifecycle", () => {
    it("creates a sandbox", async () => {
      sandbox = await Sandbox.create("base", opts!);
      expect(sandbox.sandboxId).toMatch(/^sbx-/);
    });

    it("lists sandboxes and includes the created one", async () => {
      const paginator = Sandbox.list(opts!);
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

    it("handles multiline output", async () => {
      const result = await sandbox.commands.run("seq 1 5");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[4]).toBe("5");
    });

    it("respects working directory", async () => {
      const result = await sandbox.commands.run("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe("/tmp");
    });

    it("runs long-running command", async () => {
      const result = await sandbox.commands.run("sleep 1 && echo done");
      expect(result.stdout.trim()).toBe("done");
    });

    it("supports pipe commands", async () => {
      const result = await sandbox.commands.run("echo 'a b c' | wc -w");
      expect(result.stdout.trim()).toBe("3");
    });

    it("whoami returns default user", async () => {
      const result = await sandbox.commands.run("whoami");
      expect(result.stdout.trim()).toBe("user");
    });

    it("can run as root", async () => {
      const result = await sandbox.commands.run("whoami", { user: "root" });
      expect(result.stdout.trim()).toBe("root");
    });
  });

  // ── Filesystem ─────────────────────────────────────────────

  describe("Filesystem", () => {
    it("writes and reads a file", async () => {
      await sandbox.files.write("/tmp/test.txt", "hello e2b");
      const content = await sandbox.files.read("/tmp/test.txt");
      expect(content).toBe("hello e2b");
    });

    it("lists directory entries", async () => {
      await sandbox.commands.run("mkdir -p /tmp/testdir && touch /tmp/testdir/a.txt /tmp/testdir/b.txt");
      const entries = await sandbox.files.list("/tmp/testdir");
      const names = entries.map((e) => e.name).sort();
      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
    });

    it("overwrites a file", async () => {
      await sandbox.files.write("/tmp/over.txt", "first");
      await sandbox.files.write("/tmp/over.txt", "second");
      const content = await sandbox.files.read("/tmp/over.txt");
      expect(content).toBe("second");
    });

    it("verifies file written by SDK via shell command", async () => {
      await sandbox.files.write("/tmp/verify.txt", "check123");
      const result = await sandbox.commands.run("cat /tmp/verify.txt");
      expect(result.stdout).toBe("check123");
    });

    it("reads file created by shell command via SDK", async () => {
      await sandbox.commands.run("echo -n 'from-cmd' > /tmp/cmd-file.txt");
      const content = await sandbox.files.read("/tmp/cmd-file.txt");
      expect(content).toBe("from-cmd");
    });
  });

  // ── Multiple Sandboxes ─────────────────────────────────────

  describe("Multiple Sandboxes", () => {
    it("runs two sandboxes concurrently", async () => {
      const sandbox2 = await Sandbox.create("base", opts!);
      expect(sandbox2.sandboxId).not.toBe(sandbox.sandboxId);

      const [r1, r2] = await Promise.all([
        sandbox.commands.run("echo sb1"),
        sandbox2.commands.run("echo sb2"),
      ]);
      expect(r1.stdout.trim()).toBe("sb1");
      expect(r2.stdout.trim()).toBe("sb2");

      await sandbox2.kill();
    });

    it("has isolated filesystems between sandboxes", async () => {
      const sbA = await Sandbox.create("base", opts!);
      const sbB = await Sandbox.create("base", opts!);

      await sbA.files.write("/tmp/isolated.txt", "sandbox-a");
      const resultB = await sbB.commands.run("cat /tmp/isolated.txt 2>&1 || echo NOT_FOUND");
      expect(
        resultB.stdout.includes("NOT_FOUND") || resultB.stdout.includes("No such file"),
      ).toBe(true);

      await sbA.kill();
      await sbB.kill();
    });
  });

  // ── Cleanup ────────────────────────────────────────────────

  describe("Cleanup", () => {
    it("kills the sandbox", async () => {
      await sandbox.kill();
    });

    it("sandbox is no longer in the list after kill", async () => {
      const paginator = Sandbox.list(opts!);
      const sandboxes = await paginator.nextItems();
      const found = sandboxes.find((s) => s.sandboxId === sandbox.sandboxId);
      expect(found).toBeUndefined();
    });
  });
});
