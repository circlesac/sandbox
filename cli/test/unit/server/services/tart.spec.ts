import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
  config: { envdPort: 49983 },
}));

// Mock execSync for tart CLI calls
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// Mock net for port allocation and TCP proxy
const mockPort = 54321;
const mockProxyServer = {
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};
const mockConnect = vi.fn();
vi.mock("node:net", () => ({
  createServer: (...args: unknown[]) => {
    // If called with a connection handler, it's the TCP proxy
    if (typeof args[0] === "function") {
      return mockProxyServer;
    }
    // Otherwise it's the port finder
    return {
      listen: (_port: number, cb: () => void) => cb(),
      address: () => ({ port: mockPort }),
      close: (cb: () => void) => cb(),
      on: () => ({}),
    };
  },
  connect: mockConnect,
}));

// Mock Bun.spawn
const mockProc = { pid: 12345 };
const spawnMock = vi.fn().mockReturnValue(mockProc);
globalThis.Bun = { spawn: spawnMock } as unknown as typeof Bun;

const { TartBackend } = await import(
  "../../../../src/server/services/tart.ts"
);

describe("TartBackend", () => {
  let backend: InstanceType<typeof TartBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new TartBackend();
  });

  it("has type tart", () => {
    expect(backend.type).toBe("tart");
  });

  it("supports pause", () => {
    expect(backend.supportsPause).toBe(true);
  });

  describe("resolveImage", () => {
    it("returns image name when VM exists", async () => {
      execSyncMock.mockReturnValue(
        JSON.stringify([{ Name: "sandbox-base", State: "stopped" }]),
      );

      const result = await backend.resolveImage("base");
      expect(result).toBe("sandbox-base");
    });

    it("returns prefixed name for non-base template", async () => {
      execSyncMock.mockReturnValue(
        JSON.stringify([{ Name: "sandbox-python", State: "stopped" }]),
      );

      const result = await backend.resolveImage("python");
      expect(result).toBe("sandbox-python");
    });

    it("throws when template VM does not exist", async () => {
      execSyncMock.mockReturnValue(JSON.stringify([]));

      await expect(backend.resolveImage("python")).rejects.toThrow(
        'Template "python" not found',
      );
    });
  });

  describe("createContainer", () => {
    it("clones and runs the VM", async () => {
      // resolveImage call
      execSyncMock
        .mockReturnValueOnce(
          JSON.stringify([{ Name: "sandbox-base", State: "stopped" }]),
        )
        // clone call
        .mockReturnValueOnce("")
        // tart ip call
        .mockReturnValueOnce("192.168.64.5");

      // Mock fetch for health check
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 }) as unknown as typeof fetch;

      // Speed up the initial boot delay (setTimeout)
      vi.useRealTimers();
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void, _ms?: number) => originalSetTimeout(fn, 0)) as typeof setTimeout;

      const result = await backend.createContainer({
        sandboxId: "sbx-test1",
        accessToken: "token-abc",
        templateId: "base",
        timeoutSec: 300,
      });

      globalThis.setTimeout = originalSetTimeout;
      globalThis.fetch = originalFetch;

      expect(result.instanceId).toBe("sandbox-sbx-test1");
      expect(result.hostPort).toBe(mockPort);

      // Verify tart clone was called
      expect(execSyncMock).toHaveBeenCalledWith(
        "tart clone sandbox-base sandbox-sbx-test1",
        expect.objectContaining({ encoding: "utf-8" }),
      );

      // Verify tart run was spawned with --suspendable
      expect(spawnMock).toHaveBeenCalledWith(
        ["tart", "run", "sandbox-sbx-test1", "--no-graphics", "--suspendable"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
    });
  });

  describe("stopContainer", () => {
    it("returns false for unknown sandbox", async () => {
      const result = await backend.stopContainer("sbx-unknown");
      expect(result).toBe(false);
    });
  });

  describe("removeContainer", () => {
    it("returns false for unknown sandbox", async () => {
      const result = await backend.removeContainer("sbx-unknown");
      expect(result).toBe(false);
    });
  });

  describe("inspectSandbox", () => {
    it("returns null for unknown sandbox", async () => {
      const result = await backend.inspectSandbox("sbx-unknown");
      expect(result).toBeNull();
    });
  });

  describe("listSandboxes", () => {
    it("returns empty list when no instances", async () => {
      execSyncMock.mockReturnValue(JSON.stringify([]));
      const list = await backend.listSandboxes();
      expect(list).toHaveLength(0);
    });
  });
});
