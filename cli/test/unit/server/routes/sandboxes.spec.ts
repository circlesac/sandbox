import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromHono, extendZodWithOpenApi } from "chanfana";
import { z } from "zod";
import { Hono } from "hono";
import { NotFoundError, type SandboxService } from "../../../../src/server/services/sandbox.ts";

extendZodWithOpenApi(z);

import {
  CreateSandbox,
  DeleteSandbox,
  GetSandbox,
  ListSandboxes,
  PauseSandbox,
  ResumeSandbox,
  SetSandboxTimeout,
  setSandboxService,
} from "../../../../src/server/controllers/sandboxes/index.ts";

function createMockService(): SandboxService {
  return {
    create: vi.fn().mockResolvedValue({
      sandboxID: "sbx-test123",
      templateID: "base",
      clientID: "sbx-test123",
      envdVersion: "0.5.3",
      envdAccessToken: "token-abc",
      trafficAccessToken: null,
      domain: null,
    }),
    getInfo: vi.fn().mockResolvedValue({
      sandboxID: "sbx-test123",
      templateID: "base",
      clientID: "sbx-test123",
      envdVersion: "0.5.3",
      domain: null,
      startedAt: "2026-02-15T00:00:00Z",
      endAt: "2026-02-15T00:05:00Z",
    }),
    kill: vi.fn().mockResolvedValue(true),
    pause: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue({
      sandboxID: "sbx-test123",
      templateID: "base",
      clientID: "sbx-test123",
      envdVersion: "0.5.3",
      envdAccessToken: "token-abc",
      trafficAccessToken: null,
      domain: null,
    }),
    setTimeout: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  } as unknown as SandboxService;
}

describe("sandbox controllers", () => {
  let app: Hono;
  let service: ReturnType<typeof createMockService>;

  beforeEach(() => {
    service = createMockService();
    setSandboxService(service as unknown as SandboxService);

    app = new Hono();
    const openapi = fromHono(app);
    openapi.get("/sandboxes", ListSandboxes);
    openapi.post("/sandboxes", CreateSandbox);
    openapi.get("/sandboxes/:sandboxID", GetSandbox);
    openapi.delete("/sandboxes/:sandboxID", DeleteSandbox);
    openapi.post("/sandboxes/:sandboxID/pause", PauseSandbox);
    openapi.post("/sandboxes/:sandboxID/resume", ResumeSandbox);
    openapi.post("/sandboxes/:sandboxID/timeout", SetSandboxTimeout);
  });

  describe("GET /sandboxes", () => {
    it("returns 200 with empty list", async () => {
      const res = await app.request("/sandboxes");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns 200 with sandbox list", async () => {
      (service.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sandboxID: "sbx-test123",
          templateID: "base",
          clientID: "sbx-test123",
          envdVersion: "0.5.3",
          domain: null,
          startedAt: "2026-02-15T00:00:00Z",
          endAt: "2026-02-15T00:05:00Z",
        },
      ]);

      const res = await app.request("/sandboxes");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>[];
      expect(body).toHaveLength(1);
      expect(body[0]!.sandboxID).toBe("sbx-test123");
    });
  });

  describe("POST /sandboxes", () => {
    it("returns 201 with sandbox response", async () => {
      const res = await app.request("/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "base" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sandboxID).toBe("sbx-test123");
      expect(body.envdAccessToken).toBe("token-abc");
    });
  });

  describe("GET /sandboxes/:sandboxID", () => {
    it("returns 200 with sandbox info", async () => {
      const res = await app.request("/sandboxes/sbx-test123");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sandboxID).toBe("sbx-test123");
    });

    it("returns 404 for unknown sandbox", async () => {
      (service.getInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.request("/sandboxes/sbx-missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /sandboxes/:sandboxID", () => {
    it("returns 204 on success", async () => {
      const res = await app.request("/sandboxes/sbx-test123", {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });

    it("returns 404 for unknown sandbox", async () => {
      (service.kill as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const res = await app.request("/sandboxes/sbx-missing", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /sandboxes/:sandboxID/pause", () => {
    it("returns 204 on success", async () => {
      const res = await app.request("/sandboxes/sbx-test123/pause", {
        method: "POST",
      });
      expect(res.status).toBe(204);
    });
  });

  describe("POST /sandboxes/:sandboxID/resume", () => {
    it("returns 200 with connect response", async () => {
      const res = await app.request("/sandboxes/sbx-test123/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 300 }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sandboxID).toBe("sbx-test123");
    });

    it("returns 404 for unknown sandbox", async () => {
      (service.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new NotFoundError("not found"),
      );

      const res = await app.request("/sandboxes/sbx-missing/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 300 }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /sandboxes/:sandboxID/timeout", () => {
    it("returns 204 on success", async () => {
      const res = await app.request("/sandboxes/sbx-test123/timeout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 600 }),
      });
      expect(res.status).toBe(204);
    });
  });
});
