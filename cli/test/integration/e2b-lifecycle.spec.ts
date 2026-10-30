import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Sandbox } from "e2b";
import { afterAll, describe, expect, it } from "vitest";

const SERVER_INFO_PATH = "/tmp/sandbox-integration-test.json";

const serverInfo: { port: number; apiKey: string } | null = existsSync(
	SERVER_INFO_PATH,
)
	? JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"))
	: null;

const url = serverInfo ? `http://localhost:${serverInfo.port}` : "";
const opts = serverInfo
	? { apiUrl: url, apiKey: serverInfo.apiKey, sandboxUrl: url }
	: undefined;

const APP_PORT = 3000;

async function waitFor<T>(
	probe: () => Promise<T | undefined>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => undefined);
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** GET a sandbox port through the control plane, routed by E2B's headers. */
function viaHeaders(
	sandboxId: string,
	port: number,
	headers: Record<string, string> = {},
) {
	return fetch(`${url}/`, {
		headers: {
			"E2b-Sandbox-Id": sandboxId,
			"E2b-Sandbox-Port": String(port),
			...headers,
		},
	});
}

/** GET through the control plane with a Host header, as a browser on getHost() would. */
function viaHost(host: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: serverInfo?.port,
				path: "/",
				headers: { host },
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function startHttpServer(sandbox: Sandbox) {
	await sandbox.files.write("/tmp/www/index.html", "hello from the sandbox");
	await sandbox.commands.run(
		`python3 -m http.server ${APP_PORT} --directory /tmp/www`,
		{ background: true },
	);
	await waitFor(
		async () => {
			const res = await viaHeaders(sandbox.sandboxId, APP_PORT, {
				"e2b-traffic-access-token": sandbox.trafficAccessToken ?? "",
			});
			return res.status === 200 ? true : undefined;
		},
		15_000,
		"the sandbox HTTP server",
	);
}

describe.skipIf(!opts)("E2B lifecycle and ports", { timeout: 120_000 }, () => {
	const created: string[] = [];

	afterAll(async () => {
		await Promise.allSettled(created.map((id) => Sandbox.kill(id, opts)));
	});

	it("serves any sandbox port by Host header and by E2B routing headers", async () => {
		const sandbox = await Sandbox.create("base", opts);
		created.push(sandbox.sandboxId);
		await startHttpServer(sandbox);

		const host = sandbox.getHost(APP_PORT);
		expect(host).toBe(
			`${APP_PORT}-${sandbox.sandboxId}.localhost:${serverInfo?.port}`,
		);
		const byHost = await viaHost(host);
		expect(byHost.status).toBe(200);
		expect(byHost.body).toBe("hello from the sandbox");

		// E2B hosts may add an old client ID after the sandbox ID.
		const withClientId = await viaHost(
			`${APP_PORT}-${sandbox.sandboxId}-6532622b.localhost:${serverInfo?.port}`,
		);
		expect(withClientId.body).toBe("hello from the sandbox");

		const byHeaders = await viaHeaders(sandbox.sandboxId, APP_PORT);
		expect(await byHeaders.text()).toBe("hello from the sandbox");

		const closedPort = await viaHeaders(sandbox.sandboxId, 3999);
		expect(closedPort.status).toBe(502);
	});

	it("reports the envd version in the sandbox's image", async () => {
		const sandbox = await Sandbox.create("base", opts);
		created.push(sandbox.sandboxId);
		const { envdVersion } = await Sandbox.getInfo(sandbox.sandboxId, opts);
		const [major, minor] = envdVersion.split(".").map(Number);
		// The base image builds envd from upstream main, far past the 0.5.3 default.
		expect(envdVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect((major ?? 0) * 1000 + (minor ?? 0)).toBeGreaterThan(5);

		// Newer envd versions switch the SDK to octet-stream uploads.
		await sandbox.files.write("/home/user/upload.bin", "x".repeat(100_000));
		expect((await sandbox.files.read("/home/user/upload.bin")).length).toBe(
			100_000,
		);
	});

	it("serves a port that listens only on loopback, as E2B does", async () => {
		const sandbox = await Sandbox.create("base", opts);
		created.push(sandbox.sandboxId);
		await sandbox.files.write("/tmp/local/index.html", "loopback only");
		await sandbox.commands.run(
			"python -m http.server 3210 --bind 127.0.0.1 --directory /tmp/local",
			{ background: true },
		);
		const res = await waitFor(
			async () => {
				const r = await viaHeaders(sandbox.sandboxId, 3210);
				return r.status === 200 ? r : undefined;
			},
			15_000,
			"the loopback-only server",
		);
		expect(await res.text()).toBe("loopback only");

		// The forward admits the host side only, never another sandbox.
		const address = spawnSync(
			"docker",
			[
				"inspect",
				"--format",
				"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
				sandbox.sandboxId,
			],
			{ encoding: "utf-8" },
		).stdout.trim();
		expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		const neighbor = await Sandbox.create("base", opts);
		created.push(neighbor.sandboxId);
		const probe = await neighbor.commands.run(
			`curl -s -m 5 -o /dev/null -w '%{http_code}' http://${address}:3210/ || true`,
		);
		expect(probe.stdout.trim()).not.toBe("200");
	});

	it("kills a sandbox on timeout by default and never brings it back", async () => {
		const sandbox = await Sandbox.create("base", { ...opts, timeoutMs: 3_000 });
		created.push(sandbox.sandboxId);

		await waitFor(
			async () => {
				const all = await Sandbox.list(opts).nextItems();
				return all.some((s) => s.sandboxId === sandbox.sandboxId)
					? undefined
					: true;
			},
			15_000,
			"the sandbox to be killed",
		);
		const traffic = await viaHeaders(sandbox.sandboxId, 49983);
		expect(traffic.status).toBe(502);
		await expect(Sandbox.connect(sandbox.sandboxId, opts)).rejects.toThrow();
		const all = await Sandbox.list(opts).nextItems();
		expect(all.some((s) => s.sandboxId === sandbox.sandboxId)).toBe(false);
	});

	it("pauses on timeout keeping running processes, and resumes on traffic", async () => {
		const sandbox = await Sandbox.create("base", {
			...opts,
			timeoutMs: 4_000,
			lifecycle: { onTimeout: "pause", autoResume: true },
		});
		created.push(sandbox.sandboxId);
		await startHttpServer(sandbox);

		await waitFor(
			async () => {
				const info = await Sandbox.getInfo(sandbox.sandboxId, opts);
				return info.state === "paused" ? true : undefined;
			},
			15_000,
			"the sandbox to pause",
		);

		// The HTTP server started before the pause answers without a restart.
		const res = await viaHeaders(sandbox.sandboxId, APP_PORT);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello from the sandbox");
		const info = await Sandbox.getInfo(sandbox.sandboxId, opts);
		expect(info.state).toBe("running");
	});

	it("stays paused on traffic when autoResume is off", async () => {
		const sandbox = await Sandbox.create("base", {
			...opts,
			timeoutMs: 3_000,
			lifecycle: { onTimeout: "pause" },
		});
		created.push(sandbox.sandboxId);

		await waitFor(
			async () => {
				const info = await Sandbox.getInfo(sandbox.sandboxId, opts);
				return info.state === "paused" ? true : undefined;
			},
			15_000,
			"the sandbox to pause",
		);
		const res = await viaHeaders(sandbox.sandboxId, 49983);
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("Sandbox.connect()");
		expect((await Sandbox.getInfo(sandbox.sandboxId, opts)).state).toBe(
			"paused",
		);

		const resumed = await Sandbox.connect(sandbox.sandboxId, opts);
		const echo = await resumed.commands.run("echo resumed");
		expect(echo.stdout.trim()).toBe("resumed");
	});

	it("requires the traffic access token when public traffic is off", async () => {
		const sandbox = await Sandbox.create("base", {
			...opts,
			network: { allowPublicTraffic: false },
		});
		created.push(sandbox.sandboxId);
		expect(sandbox.trafficAccessToken).toBeTruthy();
		await startHttpServer(sandbox);

		expect((await viaHeaders(sandbox.sandboxId, APP_PORT)).status).toBe(403);
		const ok = await viaHeaders(sandbox.sandboxId, APP_PORT, {
			"e2b-traffic-access-token": sandbox.trafficAccessToken ?? "",
		});
		expect(ok.status).toBe(200);
	});

	it.each([
		[
			"allowInternetAccess: false",
			{ allowInternetAccess: false },
			"allow_internet_access",
		],
		["volumeMounts", { volumeMounts: { "/data": "shared" } }, "volumeMounts"],
	])("rejects %s with an error that names it", async (_label, extra, field) => {
		const before = (await Sandbox.list(opts).nextItems()).length;
		await expect(Sandbox.create("base", { ...opts, ...extra })).rejects.toThrow(
			new RegExp(field),
		);
		expect((await Sandbox.list(opts).nextItems()).length).toBe(before);
	});
});
