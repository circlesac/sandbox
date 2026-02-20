import { fromHono, extendZodWithOpenApi } from "chanfana";
import { z } from "zod";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth.ts";
import { resolveSandboxByToken } from "./services/proxy.ts";

// Extend Zod with OpenAPI support (must be done before importing controllers)
extendZodWithOpenApi(z);

import {
  ConnectSandbox,
  CreateSandbox,
  DeleteSandbox,
  GetSandbox,
  ListSandboxes,
  PauseSandbox,
  ResumeSandbox,
  SetSandboxTimeout,
  setSandboxService,
} from "./controllers/sandboxes/index.ts";
import { DockerService } from "./services/docker.ts";
import { EnvdService } from "./services/envd.ts";
import { SandboxService } from "./services/sandbox.ts";
import { TtlService } from "./services/ttl.ts";
import { handleProxyRequest } from "./services/proxy.ts";

export function createApp() {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", logger());

  // Services
  const dockerService = new DockerService();
  const envdService = new EnvdService();
  const ttlService = new TtlService();
  const sandboxService = new SandboxService(dockerService, envdService, ttlService);
  setSandboxService(sandboxService);

  // Data plane routing: proxy envd requests to sandbox containers
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";

    // Route by Host header: {port}-{sandboxId}.{domain}
    if (/^\d+-sbx-/.test(host)) {
      return handleProxyRequest(c, dockerService);
    }

    // Route by E2B SDK header (gRPC transport includes sandbox ID)
    const sandboxId = c.req.header("E2b-Sandbox-Id");
    if (sandboxId) {
      return handleProxyRequest(c, dockerService, sandboxId);
    }

    // Route by access token (envd REST API — files, health)
    const accessToken = c.req.header("X-Access-Token");
    if (accessToken) {
      const resolvedId = resolveSandboxByToken(accessToken);
      if (resolvedId) {
        return handleProxyRequest(c, dockerService, resolvedId);
      }
    }

    // Control plane
    await next();
  });

  // Health (no auth)
  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI router
  const openapi = fromHono(app, {
    docs_url: "/docs",
    schema: {
      info: {
        title: "Sandbox Control Plane",
        version: "1.0.0",
        description: "E2B-compatible sandbox lifecycle management API",
      },
      tags: [
        { name: "Sandboxes", description: "Sandbox lifecycle management" },
      ],
    },
  });

  // Auth middleware for sandbox routes
  app.use("/sandboxes", authMiddleware);
  app.use("/sandboxes/*", authMiddleware);
  app.use("/v2/sandboxes", authMiddleware);
  app.use("/v2/sandboxes/*", authMiddleware);

  // Register endpoints
  openapi.get("/sandboxes", ListSandboxes);
  openapi.post("/sandboxes", CreateSandbox);
  openapi.get("/sandboxes/:sandboxID", GetSandbox);
  openapi.delete("/sandboxes/:sandboxID", DeleteSandbox);
  openapi.post("/sandboxes/:sandboxID/pause", PauseSandbox);
  openapi.post("/sandboxes/:sandboxID/resume", ResumeSandbox);
  openapi.post("/sandboxes/:sandboxID/connect", ConnectSandbox);
  openapi.post("/sandboxes/:sandboxID/timeout", SetSandboxTimeout);

  // E2B SDK v2 compat — SDK uses /v2/sandboxes for list
  openapi.get("/v2/sandboxes", ListSandboxes);

  return { app, dockerService, sandboxService, ttlService };
}
