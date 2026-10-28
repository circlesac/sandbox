import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromHono, extendZodWithOpenApi } from "chanfana";
import { z } from "zod";
import { Hono } from "hono";
import { RetryableError } from "../../../../src/server/errors.ts";
import {
	NotFoundError,
	type SandboxService,
	UnsupportedError,
} from "../../../../src/server/services/sandbox.ts";

extendZodWithOpenApi(z);

import {
	registerSandboxRoutes,
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
		registerSandboxRoutes(fromHono(app));
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

	describe("POST /v2/sandboxes", () => {
		it("creates a sandbox from the v2 body and returns 201", async () => {
			const body = {
				templateID: "base",
				timeout: 300,
				metadata: { platform: "linux" },
				envVars: { FOO: "bar" },
			};
			const res = await app.request("/v2/sandboxes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(201);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.sandboxID).toBe("sbx-test123");
			expect(json.envdAccessToken).toBe("token-abc");
			expect(service.create).toHaveBeenCalledWith(body);
		});
	});

	describe("POST /v2/sandboxes/:sandboxID/connect", () => {
		it("connects with the requested timeout", async () => {
			const res = await app.request("/v2/sandboxes/sbx-test123/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ timeout: 600 }),
			});
			expect([200, 201]).toContain(res.status);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.sandboxID).toBe("sbx-test123");
			expect(service.connect).toHaveBeenCalledWith("sbx-test123", 600);
		});

		it("accepts an omitted body, which v2 makes optional", async () => {
			const res = await app.request("/v2/sandboxes/sbx-test123/connect", {
				method: "POST",
			});
			expect([200, 201]).toContain(res.status);
			expect(service.connect).toHaveBeenCalledWith("sbx-test123", undefined);
		});

		it("returns 404 for an unknown sandbox", async () => {
			vi.mocked(service.connect).mockRejectedValueOnce(
				new NotFoundError("Sandbox sbx-missing not found"),
			);
			const res = await app.request("/v2/sandboxes/sbx-missing/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ timeout: 60 }),
			});
			expect(res.status).toBe(404);
		});
	});

	describe("POST /sandboxes errors", () => {
		const post = () =>
			app.request("/sandboxes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ templateID: "base" }),
			});

		it("returns 503 with Retry-After while the template image downloads", async () => {
			vi.mocked(service.create).mockRejectedValueOnce(
				new RetryableError("image is still downloading; retry shortly", 10),
			);
			const res = await post();
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("10");
			expect(res.headers.get("Should-Retry")).toBe("true");
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.message).toMatch(/still downloading/);
		});

		it("returns 404 for an unknown template", async () => {
			vi.mocked(service.create).mockRejectedValueOnce(
				new NotFoundError('Template "nope" not found'),
			);
			const res = await post();
			expect(res.status).toBe(404);
		});

		it("returns 400 for an unsupported request", async () => {
			vi.mocked(service.create).mockRejectedValueOnce(
				new UnsupportedError("volumeMounts is not supported"),
			);
			const res = await post();
			expect(res.status).toBe(400);
		});
	});

	describe("POST /sandboxes abandoned by the client", () => {
		it("kills the sandbox when the client disconnected before creation finished", async () => {
			const controller = new AbortController();
			vi.mocked(service.create).mockImplementationOnce(async () => {
				controller.abort();
				return {
					sandboxID: "sbx-orphan",
					templateID: "base",
					clientID: "sbx-orphan",
					envdVersion: "0.5.3",
					envdAccessToken: "token",
					trafficAccessToken: null,
					domain: null,
				};
			});
			await app.request("/sandboxes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ templateID: "base" }),
				signal: controller.signal,
			});
			expect(service.kill).toHaveBeenCalledWith("sbx-orphan");
		});

		it("keeps the sandbox when the client is still connected", async () => {
			await app.request("/sandboxes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ templateID: "base" }),
			});
			expect(service.kill).not.toHaveBeenCalled();
		});
	});
});
