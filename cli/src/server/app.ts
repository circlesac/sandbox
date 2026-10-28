import { fromHono, extendZodWithOpenApi } from "chanfana";
import { z } from "zod";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.ts";
import { authMiddleware } from "./middleware/auth.ts";

// Extend Zod with OpenAPI support (must be done before importing controllers)
extendZodWithOpenApi(z);

import {
	registerSandboxRoutes,
	setSandboxService,
} from "./controllers/sandboxes/index.ts";
import {
	createBackends,
	type BackendMap,
	type BackendType,
} from "./services/backend.ts";
import { EnvdService } from "./services/envd.ts";
import { SandboxService } from "./services/sandbox.ts";
import { TtlService } from "./services/ttl.ts";
import {
	handleProxyRequest,
	parseSandboxHost,
	resolveDebugSandbox,
	resolveSandboxByToken,
} from "./services/proxy.ts";

export function createApp(opts?: {
	backendType?: BackendType;
	macosBackendType?: BackendType;
}) {
	const app = new Hono();

	app.use("*", cors());
	app.use("*", logger());

	// Services
	const backends = createBackends({
		linux: opts?.backendType ?? (config.backend as BackendType),
		macos:
			opts?.macosBackendType ??
			(config.macosBackend as BackendType | undefined),
		dockerSocket: config.dockerSocket,
	});
	const envdService = new EnvdService();
	const ttlService = new TtlService();
	const sandboxService = new SandboxService(backends, envdService, ttlService);
	setSandboxService(sandboxService);
	// Data plane routing: proxy requests for sandbox ports to the sandboxes
	app.use("*", async (c, next) => {
		// Route by Host header: {port}-{sandboxId}.{domain}
		const byHost = parseSandboxHost(c.req.header("host") ?? "");
		if (byHost) return handleProxyRequest(c, sandboxService, byHost);

		// Route by the E2B SDK's E2b-Sandbox-Id / E2b-Sandbox-Port headers
		const headerId = c.req.header("E2b-Sandbox-Id");
		if (headerId) {
			const sandboxId = await resolveDebugSandbox(headerId, sandboxService);
			if (!sandboxId) {
				return c.json({ code: 502, message: "No running sandbox found" }, 502);
			}
			const portHeader = c.req.header("E2b-Sandbox-Port");
			const port = portHeader ? Number(portHeader) : config.envdPort;
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				return c.json(
					{ code: 400, message: `Invalid sandbox port ${portHeader}` },
					400,
				);
			}
			return handleProxyRequest(c, sandboxService, { sandboxId, port });
		}

		// Route by access token (envd REST API — files, health)
		const accessToken = c.req.header("X-Access-Token");
		if (accessToken) {
			const sandboxId = resolveSandboxByToken(accessToken);
			if (sandboxId) {
				return handleProxyRequest(c, sandboxService, {
					sandboxId,
					port: config.envdPort,
				});
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

	registerSandboxRoutes(openapi);

	return { app, backends, sandboxService, ttlService };
}
