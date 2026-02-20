import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxService } from "../../../../src/server/services/sandbox.ts";
import type { DockerService } from "../../../../src/server/services/docker.ts";
import type { EnvdService } from "../../../../src/server/services/envd.ts";
import { TtlService } from "../../../../src/server/services/ttl.ts";

vi.mock("../../../../src/server/config.ts", () => ({
  config: {
    defaultTimeoutSec: 300,
    maxTimeoutSec: 3600,
    envdVersion: "0.5.3",
    defaultUser: "user",
  },
}));

function createMockDocker(): DockerService {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: "container-123",
      hostPort: 32768,
    }),
    inspectSandbox: vi.fn().mockResolvedValue({
      sandboxId: "sbx-test123",
      containerId: "container-123",
      accessToken: "token-abc",
      templateId: "base",
      createdAt: new Date().toISOString(),
      timeoutSec: 300,
      hostPort: 32768,
      state: "running" as const,
    }),
    removeContainer: vi.fn().mockResolvedValue(true),
    stopContainer: vi.fn().mockResolvedValue(true),
    startContainer: vi.fn().mockResolvedValue({ hostPort: 32769 }),
    listSandboxes: vi.fn().mockResolvedValue([]),
  } as unknown as DockerService;
}

function createMockEnvd(): EnvdService {
  return {
    waitForHealth: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  } as unknown as EnvdService;
}

describe("SandboxService", () => {
  let docker: ReturnType<typeof createMockDocker>;
  let envd: ReturnType<typeof createMockEnvd>;
  let ttl: TtlService;
  let service: SandboxService;

  beforeEach(() => {
    vi.useFakeTimers();
    docker = createMockDocker();
    envd = createMockEnvd();
    ttl = new TtlService();
    service = new SandboxService(
      docker as unknown as DockerService,
      envd as unknown as EnvdService,
      ttl,
    );
  });

  describe("create", () => {
    it("creates container, waits for health, inits envd, returns response", async () => {
      const result = await service.create({ templateID: "base" });

      expect(result.sandboxID).toMatch(/^sbx-/);
      expect(result.templateID).toBe("base");
      expect(result.envdVersion).toBe("0.5.3");
      expect(result.envdAccessToken).toBeTruthy();
      expect(result.trafficAccessToken).toBeNull();

      expect(docker.createContainer).toHaveBeenCalledOnce();
      expect(envd.waitForHealth).toHaveBeenCalledWith(32768);
      expect(envd.init).toHaveBeenCalledOnce();
    });

    it("cleans up container if envd health check fails", async () => {
      (envd.waitForHealth as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("timeout"),
      );

      await expect(service.create({ templateID: "base" })).rejects.toThrow(
        "timeout",
      );
      expect(docker.removeContainer).toHaveBeenCalledOnce();
    });

    it("clamps timeout to maxTimeoutSec", async () => {
      await service.create({ templateID: "base", timeout: 99999 });

      const createCall = (docker.createContainer as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0];
      expect(createCall.timeoutSec).toBe(3600);
    });
  });

  describe("kill", () => {
    it("removes container and clears TTL", async () => {
      const clearSpy = vi.spyOn(ttl, "clear");
      const result = await service.kill("sbx-test");

      expect(result).toBe(true);
      expect(docker.removeContainer).toHaveBeenCalledWith("sbx-test");
      expect(clearSpy).toHaveBeenCalledWith("sbx-test");
    });
  });

  describe("pause", () => {
    it("stops container and clears TTL", async () => {
      const clearSpy = vi.spyOn(ttl, "clear");
      const result = await service.pause("sbx-test");

      expect(result).toBe(true);
      expect(docker.stopContainer).toHaveBeenCalledWith("sbx-test");
      expect(clearSpy).toHaveBeenCalledWith("sbx-test");
    });
  });

  describe("connect", () => {
    it("starts container, waits for health, inits envd", async () => {
      const result = await service.connect("sbx-test123");

      expect(result.sandboxID).toBe("sbx-test123");
      expect(result.envdAccessToken).toBe("token-abc");
      expect(docker.startContainer).toHaveBeenCalledWith("sbx-test123");
      expect(envd.waitForHealth).toHaveBeenCalledWith(32769);
      expect(envd.init).toHaveBeenCalledOnce();
    });

    it("throws NotFoundError if sandbox does not exist", async () => {
      (docker.inspectSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );

      await expect(service.connect("sbx-missing")).rejects.toThrow(
        "not found",
      );
    });
  });

  afterEach(() => {
    ttl.clearAll();
    vi.useRealTimers();
  });
});
