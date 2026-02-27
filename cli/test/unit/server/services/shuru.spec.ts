import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
  config: { envdPort: 49983 },
}));

// Mock execSync for checkpoint listing
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// Mock net.createServer for port allocation
const mockPort = 54321;
vi.mock("node:net", () => ({
  createServer: () => ({
    listen: (_port: number, cb: () => void) => cb(),
    address: () => ({ port: mockPort }),
    close: (cb: () => void) => cb(),
    on: () => ({}),
  }),
}));

// Mock Bun.spawn
const mockProc = { pid: 12345 };
const spawnMock = vi.fn().mockReturnValue(mockProc);
vi.stubGlobal("Bun", { spawn: spawnMock });

// Track process.kill calls without calling the real one
let processAlive = true;
const killCalls: Array<[number, string | number]> = [];
vi.stubGlobal("process", {
  ...process,
  kill: (pid: number, signal?: string | number) => {
    killCalls.push([pid, signal ?? 0]);
    if (signal === 0 || signal === undefined) {
      if (!processAlive) throw new Error("ESRCH");
      return true;
    }
    return true;
  },
});

const { ShuruBackend } = await import(
  "../../../../src/server/services/shuru.ts"
);

describe("ShuruBackend", () => {
  let backend: InstanceType<typeof ShuruBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new ShuruBackend();
    processAlive = true;
    killCalls.length = 0;
  });

  it("has type shuru", () => {
    expect(backend.type).toBe("shuru");
  });

  describe("resolveImage", () => {
    it("returns checkpoint name when it exists", async () => {
      execSyncMock.mockReturnValue("sandbox-base\nsandbox-python\n");

      const result = await backend.resolveImage("base");
      expect(result).toBe("sandbox-base");
    });

    it("returns empty string for base template when no checkpoint", async () => {
      execSyncMock.mockReturnValue("");

      const result = await backend.resolveImage("base");
      expect(result).toBe("");
    });

    it("throws for non-base template when checkpoint missing", async () => {
      execSyncMock.mockReturnValue("");

      await expect(backend.resolveImage("python")).rejects.toThrow(
        'Template "python" not found',
      );
    });
  });

  describe("createContainer", () => {
    it("spawns shuru process and stores instance", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");

      const result = await backend.createContainer({
        sandboxId: "sbx-test1",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      expect(result.instanceId).toBe("12345");
      expect(result.hostPort).toBe(mockPort);
      expect(spawnMock).toHaveBeenCalledWith(
        [
          "shuru",
          "run",
          "--from",
          "sandbox-base",
          "-p",
          `${mockPort}:49983`,
          "--allow-net",
          "--",
          "envd",
          "-isnotfc",
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
    });

    it("omits --from when image is empty", async () => {
      execSyncMock.mockReturnValue("");

      await backend.createContainer({
        sandboxId: "sbx-test2",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      const args = spawnMock.mock.calls[0]![0] as string[];
      expect(args).not.toContain("--from");
    });
  });

  describe("inspectSandbox", () => {
    it("returns null for unknown sandbox", async () => {
      const result = await backend.inspectSandbox("sbx-unknown");
      expect(result).toBeNull();
    });

    it("returns info for running sandbox", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-inspect",
        accessToken: "token-xyz",
        templateId: "base",
        timeoutSec: 300,
      });

      const info = await backend.inspectSandbox("sbx-inspect");
      expect(info).not.toBeNull();
      expect(info!.sandboxId).toBe("sbx-inspect");
      expect(info!.accessToken).toBe("token-xyz");
      expect(info!.state).toBe("running");
      expect(info!.hostPort).toBe(mockPort);
    });

    it("returns null and cleans up if process is dead", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-dead",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      processAlive = false;

      const info = await backend.inspectSandbox("sbx-dead");
      expect(info).toBeNull();
    });
  });

  describe("stopContainer", () => {
    it("returns false for unknown sandbox", async () => {
      const result = await backend.stopContainer("sbx-unknown");
      expect(result).toBe(false);
    });

    it("kills process and removes from state", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-stop",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      const result = await backend.stopContainer("sbx-stop");
      expect(result).toBe(true);

      const info = await backend.inspectSandbox("sbx-stop");
      expect(info).toBeNull();
    });
  });

  describe("removeContainer", () => {
    it("returns false for unknown sandbox", async () => {
      const result = await backend.removeContainer("sbx-unknown");
      expect(result).toBe(false);
    });

    it("kills process with SIGKILL and removes from state", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-remove",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      const result = await backend.removeContainer("sbx-remove");
      expect(result).toBe(true);

      const sigkillCall = killCalls.find(([, sig]) => sig === "SIGKILL");
      expect(sigkillCall).toBeDefined();
      expect(sigkillCall![0]).toBe(12345);
    });
  });

  describe("startContainer", () => {
    it("returns port if process is still alive", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-alive",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      const result = await backend.startContainer("sbx-alive");
      expect(result.hostPort).toBe(mockPort);
    });

    it("throws for unknown sandbox", async () => {
      await expect(backend.startContainer("sbx-gone")).rejects.toThrow(
        "Cannot resume shuru sandbox",
      );
    });
  });

  describe("listSandboxes", () => {
    it("returns all running sandboxes", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-list1",
        accessToken: "token-1",
        templateId: "base",
        timeoutSec: 300,
      });
      await backend.createContainer({
        sandboxId: "sbx-list2",
        accessToken: "token-2",
        templateId: "base",
        timeoutSec: 300,
      });

      const list = await backend.listSandboxes();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.sandboxId).sort()).toEqual([
        "sbx-list1",
        "sbx-list2",
      ]);
    });

    it("filters out paused state (no paused sandboxes in shuru)", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-filter",
        accessToken: "token-1",
        templateId: "base",
        timeoutSec: 300,
      });

      const list = await backend.listSandboxes({ state: "paused" });
      expect(list).toHaveLength(0);
    });

    it("cleans up dead instances", async () => {
      execSyncMock.mockReturnValue("sandbox-base\n");
      await backend.createContainer({
        sandboxId: "sbx-cleanup",
        accessToken: "token-1",
        templateId: "base",
        timeoutSec: 300,
      });

      processAlive = false;

      const list = await backend.listSandboxes();
      expect(list).toHaveLength(0);
    });
  });
});
