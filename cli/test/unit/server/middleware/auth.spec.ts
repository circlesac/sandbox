import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock config before importing auth middleware
vi.mock("../../../../src/server/config.ts", () => ({
  config: {
    apiKeys: ["test-key-1", "test-key-2"],
  },
}));

const { authMiddleware } = await import("../../../../src/server/middleware/auth.ts");

describe("authMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));
  });

  it("allows valid API key in X-API-Key header", async () => {
    const res = await app.request("/test", {
      headers: { "X-API-Key": "test-key-1" },
    });
    expect(res.status).toBe(200);
  });

  it("allows valid API key in lowercase header", async () => {
    const res = await app.request("/test", {
      headers: { "x-api-key": "test-key-2" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects missing API key", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects invalid API key", async () => {
    const res = await app.request("/test", {
      headers: { "X-API-Key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });
});
