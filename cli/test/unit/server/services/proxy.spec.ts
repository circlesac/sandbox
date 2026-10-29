import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { UnsupportedError } from "../../../../src/server/errors.ts";
import type {
	ContainerBackend,
	ProxyTarget,
} from "../../../../src/server/services/backend.ts";
import type { SandboxLifecycle } from "../../../../src/server/services/lifecycle.ts";
import {
	clearPortCache,
	clearRoutes,
	handleProxyRequest,
	parseSandboxHost,
	type ProxyRoute,
	type ProxySandboxes,
	resolveDebugSandbox,
} from "../../../../src/server/services/proxy.ts";
import type { SandboxInfo } from "../../../../src/server/types.ts";

vi.mock("../../../../src/server/config.ts", () => ({
	config: { envdPort: 49983 },
}));

const ENVD = 49983;
const TOKEN = "tok123";

describe("parseSandboxHost", () => {
	it("reads the port and sandbox ID from {port}-{sandboxId}.{domain}", () => {
		expect(
			parseSandboxHost("49983-sbx-abc123def456.sandbox.example.com"),
		).toEqual({
			port: 49983,
			sandboxId: "sbx-abc123def456",
		});
		expect(parseSandboxHost("3000-sbx-a1b2_c3d4-e5.localhost:49982")).toEqual({
			port: 3000,
			sandboxId: "sbx-a1b2_c3d4-e5",
		});
	});

	it("ignores control-plane and bare hostnames", () => {
		expect(parseSandboxHost("api.sandbox.example.com")).toBeNull();
		expect(parseSandboxHost("localhost:3000")).toBeNull();
		expect(parseSandboxHost("")).toBeNull();
	});
});

/** A local HTTP server standing in for a sandbox port; echoes what it received. */
let upstream: Server;
let upstreamPort: number;
const received: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
	upstream = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			// A body cut off by the sandbox side, with and without a declared length.
			if (req.url === "/cut-sized" || req.url === "/cut-stream") {
				if (req.url === "/cut-sized") res.setHeader("content-length", "100");
				res.write("0123456789");
				setTimeout(() => res.socket?.destroy(), 20);
				return;
			}
			received.push({ method: req.method ?? "", url: req.url ?? "", body });
			res.setHeader("content-type", "text/plain");
			res.end(`upstream ${req.method} ${req.url}`);
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, resolve));
	upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(() => {
	upstream.close();
});

interface FakeSandbox {
	state: "running" | "paused";
	lifecycle: SandboxLifecycle;
	unsupportedPorts?: boolean;
}

function lifecycle(
	overrides: Partial<SandboxLifecycle> = {},
): SandboxLifecycle {
	return {
		autoPause: false,
		keepMemory: true,
		autoResume: false,
		secure: true,
		trafficAccessToken: null,
		...overrides,
	};
}

function setup(envdChecksAccessToken: boolean) {
	const sandboxes = new Map<string, FakeSandbox>();
	const backend = {
		envdChecksAccessToken,
		resolveTarget: vi.fn(
			async (id: string, port: number): Promise<ProxyTarget | null> => {
				const sb = sandboxes.get(id);
				if (sb?.state !== "running") return null;
				if (sb.unsupportedPorts && port !== ENVD) {
					throw new UnsupportedError(
						`Port ${port} is not reachable on the shuru backend`,
					);
				}
				return { host: "127.0.0.1", port: upstreamPort };
			},
		),
	} as unknown as ContainerBackend;

	const deps: ProxySandboxes = {
		locate: vi.fn(async (id: string) => {
			const sb = sandboxes.get(id);
			if (!sb) return null;
			return {
				backend,
				info: {
					sandboxId: id,
					accessToken: TOKEN,
					state: sb.state,
					lifecycle: sb.lifecycle,
				} as SandboxInfo,
			};
		}),
		resumeForTraffic: vi.fn(async (id: string) => {
			const sb = sandboxes.get(id);
			if (!sb) return false;
			if (sb.state === "running") return true;
			if (!sb.lifecycle.autoResume) return false;
			sb.state = "running";
			return true;
		}),
		list: vi.fn(async () =>
			[...sandboxes.entries()]
				.filter(([, sb]) => sb.state === "running")
				.map(([id]) => ({ sandboxID: id })),
		),
	};

	const app = new Hono();
	let route: ProxyRoute = { sandboxId: "sbx-a", port: ENVD };
	app.all("*", (c) => handleProxyRequest(c, deps, route));
	const request = (r: ProxyRoute, path = "/health", init?: RequestInit) => {
		route = r;
		return app.request(path, init);
	};
	return { sandboxes, deps, backend, request };
}

describe("handleProxyRequest", () => {
	beforeEach(() => {
		clearPortCache();
		received.length = 0;
	});

	it("forwards to the resolved port with method, path, query, and body", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });

		const res = await request(
			{ sandboxId: "sbx-a", port: 3000 },
			"/api/x?y=1",
			{
				method: "POST",
				body: "hello",
			},
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("upstream POST /api/x?y=1");
		expect(received).toEqual([
			{ method: "POST", url: "/api/x?y=1", body: "hello" },
		]);
	});

	it("fails a body of declared length that the sandbox cut off, and ends an open stream", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });

		const whole = await request({ sandboxId: "sbx-a", port: 3000 }, "/x");
		expect(whole.headers.get("content-length")).toBe(
			String("upstream GET /x".length),
		);
		await whole.text();

		const sized = await request(
			{ sandboxId: "sbx-a", port: 3000 },
			"/cut-sized",
		);
		await expect(sized.text()).rejects.toThrow();

		const stream = await request(
			{ sandboxId: "sbx-a", port: 3000 },
			"/cut-stream",
		);
		expect(await stream.text()).toBe("0123456789");
	});

	it("ignores an E2B client-ID suffix after the sandbox ID", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });

		const res = await request({ sandboxId: "sbx-a-6532622b", port: 3000 }, "/");
		expect(res.status).toBe(200);
		const legacy = await request(
			{ sandboxId: "sbx-a-00000000", port: 3000 },
			"/",
		);
		expect(legacy.status).toBe(200);
	});

	it("re-resolves a suffixed route after its sandbox pauses", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", {
			state: "running",
			lifecycle: lifecycle({ autoPause: true }),
		});
		const route = { sandboxId: "sbx-a-6532622b", port: 3000 };
		expect((await request(route, "/")).status).toBe(200);

		sandboxes.set("sbx-a", {
			state: "paused",
			lifecycle: lifecycle({ autoPause: true }),
		});
		clearRoutes("sbx-a");
		expect((await request(route, "/")).status).toBe(502);
	});

	it("answers 502 for an unknown sandbox instead of picking another one", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-other", { state: "running", lifecycle: lifecycle() });

		const res = await request({ sandboxId: "sbx-gone", port: ENVD });
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("sbx-gone not found");
		expect(received).toHaveLength(0);
	});

	it("resumes a paused sandbox with autoResume and then forwards", async () => {
		const { sandboxes, deps, request } = setup(true);
		sandboxes.set("sbx-a", {
			state: "paused",
			lifecycle: lifecycle({ autoPause: true, autoResume: true }),
		});

		const res = await request({ sandboxId: "sbx-a", port: 3000 }, "/");
		expect(res.status).toBe(200);
		expect(deps.resumeForTraffic).toHaveBeenCalledWith("sbx-a");
		expect(sandboxes.get("sbx-a")?.state).toBe("running");
	});

	it("keeps a paused sandbox paused without autoResume and says how to resume", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", {
			state: "paused",
			lifecycle: lifecycle({ autoPause: true }),
		});

		const res = await request({ sandboxId: "sbx-a", port: 3000 }, "/");
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("resume it with Sandbox.connect()");
		expect(sandboxes.get("sbx-a")?.state).toBe("paused");
	});

	describe("envd access token, checked here when envd itself does not", () => {
		it("rejects a request without the token and accepts it with X-Access-Token", async () => {
			const { sandboxes, request } = setup(false);
			sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });

			expect((await request({ sandboxId: "sbx-a", port: ENVD })).status).toBe(
				401,
			);
			const ok = await request({ sandboxId: "sbx-a", port: ENVD }, "/health", {
				headers: { "X-Access-Token": TOKEN },
			});
			expect(ok.status).toBe(200);
		});

		it("accepts a valid signed file URL and rejects a tampered one", async () => {
			const { sandboxes, request } = setup(false);
			sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });
			const route = { sandboxId: "sbx-a", port: ENVD };
			// sha256("/home/user/a.txt:read:user:tok123"), see lifecycle.spec.ts
			const signature = encodeURIComponent(
				"v1_HB2bgZ+RgifWQVkD4WDT8wNBFTVrggZWSRD5EqI0H/0",
			);

			const ok = await request(
				route,
				`/files?path=/home/user/a.txt&username=user&signature=${signature}`,
			);
			expect(ok.status).toBe(200);
			const tampered = await request(
				route,
				`/files?path=/etc/shadow&username=user&signature=${signature}`,
			);
			expect(tampered.status).toBe(401);
		});

		it("does not check when the sandbox is not secure or envd checks itself", async () => {
			const insecure = setup(false);
			insecure.sandboxes.set("sbx-a", {
				state: "running",
				lifecycle: lifecycle({ secure: false }),
			});
			expect(
				(await insecure.request({ sandboxId: "sbx-a", port: ENVD })).status,
			).toBe(200);

			clearPortCache();
			const envdChecks = setup(true);
			envdChecks.sandboxes.set("sbx-a", {
				state: "running",
				lifecycle: lifecycle(),
			});
			expect(
				(await envdChecks.request({ sandboxId: "sbx-a", port: ENVD })).status,
			).toBe(200);
		});
	});

	it.each([
		"/init",
		"/%69nit",
		"//init",
		"/./init",
		"/x/../init",
		"/init/",
		"/init//",
		"/freeze",
		"/upgrade",
	])(
		"keeps envd's control route %s unreachable through a sandbox URL",
		async (path) => {
			const { sandboxes, request } = setup(true);
			sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });
			const res = await request({ sandboxId: "sbx-a", port: ENVD }, path, {
				method: "POST",
				headers: { "X-Access-Token": TOKEN },
			});
			expect(res.status).toBe(404);
			expect(await res.text()).toContain("reserved for the E2B control plane");
			expect(received).toHaveLength(0);
		},
	);

	it("still forwards an app port's own /init path", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });
		const res = await request({ sandboxId: "sbx-a", port: 3000 }, "/init");
		expect(res.status).toBe(200);
	});

	it("requires the traffic access token on app ports when public traffic is off", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", {
			state: "running",
			lifecycle: lifecycle({ trafficAccessToken: "traffic-1" }),
		});
		const route = { sandboxId: "sbx-a", port: 3000 };

		expect((await request(route, "/")).status).toBe(403);
		const ok = await request(route, "/", {
			headers: { "e2b-traffic-access-token": "traffic-1" },
		});
		expect(ok.status).toBe(200);
	});

	it("explains a port the backend cannot reach", async () => {
		const { sandboxes, request } = setup(true);
		sandboxes.set("sbx-a", {
			state: "running",
			lifecycle: lifecycle(),
			unsupportedPorts: true,
		});
		const res = await request({ sandboxId: "sbx-a", port: 3000 }, "/");
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("not reachable on the shuru backend");
	});

	it("looks the sandbox up again after a failed connection", async () => {
		const { sandboxes, backend, request } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });
		const route = { sandboxId: "sbx-a", port: 3000 };

		vi.mocked(backend.resolveTarget).mockResolvedValueOnce({
			host: "127.0.0.1",
			port: 1,
		});
		expect((await request(route, "/")).status).toBe(502);
		expect((await request(route, "/")).status).toBe(200);
		expect(backend.resolveTarget).toHaveBeenCalledTimes(2);
	});
});

describe("resolveDebugSandbox", () => {
	it("maps the SDK debug placeholder to the only running sandbox", async () => {
		const { sandboxes, deps } = setup(true);
		sandboxes.set("sbx-a", { state: "running", lifecycle: lifecycle() });
		expect(await resolveDebugSandbox("debug_sandbox_id", deps)).toBe("sbx-a");
		expect(await resolveDebugSandbox(undefined, deps)).toBe("sbx-a");

		sandboxes.set("sbx-b", { state: "running", lifecycle: lifecycle() });
		expect(await resolveDebugSandbox("debug_sandbox_id", deps)).toBeNull();
	});

	it("passes any other ID through unchanged, even when it does not exist", async () => {
		const { deps } = setup(true);
		expect(await resolveDebugSandbox("sbx-gone", deps)).toBe("sbx-gone");
	});
});
