import { tmpdir } from "node:os";
import { createWriteStream, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { providers } from "./providers.ts";

const TEST_API_KEY = "e2b_0000000000000000000000000000000000000000";

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

async function waitForHealth(port: number, timeoutMs = 30_000) {
	const url = `http://localhost:${port}/health`;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(
		`Tart server did not become healthy on :${port} within ${timeoutMs}ms`,
	);
}

const skip = providers.tart.missing() !== null;

describe.skipIf(skip)("Tart E2B Smoke", { timeout: 600_000 }, () => {
	let serverProcess: ChildProcess | undefined;
	let opts: {
		apiUrl: string;
		apiKey: string;
		sandboxUrl: string;
		requestTimeoutMs: number;
		metadata: Record<string, string>;
	};
	let sandbox: Sandbox;

	beforeAll(async () => {
		const port = await findFreePort();
		const envdProxyPort = await findFreePort();
		const serverEntry = join(
			__dirname,
			"..",
			"..",
			"src",
			"server",
			"index.ts",
		);
		serverProcess = spawn("bun", ["run", serverEntry], {
			env: {
				...process.env,
				PORT: String(port),
				ENVD_PROXY_PORT: String(envdProxyPort),
				API_KEYS: TEST_API_KEY,
				SANDBOX_MACOS_BACKEND: "tart",
				// Never the user's ~/.sandbox state: a test server would overwrite it.
				SANDBOX_STATE_DIR: mkdtempSync(join(tmpdir(), "sandbox-state-")),
			},
			stdio: "pipe",
		});

		serverProcess.stderr?.on("data", (data: Buffer) => {
			process.stderr.write(`[tart-server] ${data}`);
		});
		// Its request log, kept for diagnosing a failure: tmpdir()/sandbox-tart-server.log
		serverProcess.stdout?.pipe(
			createWriteStream(join(tmpdir(), "sandbox-tart-server.log")),
		);

		await waitForHealth(port, 60_000);

		opts = {
			apiUrl: `http://localhost:${port}`,
			apiKey: TEST_API_KEY,
			sandboxUrl: `http://localhost:${port}`,
			requestTimeoutMs: 600_000,
			metadata: { platform: "macos" },
		};
	}, 120_000);

	afterAll(async () => {
		try {
			const paginator = Sandbox.list(opts);
			const all = await paginator.nextItems();
			await Promise.allSettled(all.map((s) => Sandbox.kill(s.sandboxId, opts)));
		} catch {
			// best-effort cleanup
		}
		serverProcess?.kill("SIGTERM");
	});

	// ── Lifecycle ──────────────────────────────────────────────

	describe("Lifecycle", () => {
		it("creates a sandbox", async () => {
			// This sandbox lives for the whole suite, which can outlast the
			// default 300 s (it took 406 s under coverage instrumentation).
			sandbox = await Sandbox.create("base", { ...opts, timeoutMs: 1_800_000 });
			expect(sandbox.sandboxId).toMatch(/^sbx-/);
		});

		it("lists sandboxes and includes the created one", async () => {
			const paginator = Sandbox.list(opts);
			const sandboxes = await paginator.nextItems();
			const found = sandboxes.find((s) => s.sandboxId === sandbox.sandboxId);
			expect(found).toBeDefined();
		});
	});

	// ── Commands ───────────────────────────────────────────────

	describe("Commands", () => {
		it("runs echo command", async () => {
			const result = await sandbox.commands.run("echo hello world");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("hello world");
		});

		it("handles non-zero exit code", async () => {
			await expect(sandbox.commands.run("exit 42")).rejects.toThrow();
		});

		it("captures stderr", async () => {
			const result = await sandbox.commands.run("echo error >&2");
			expect(result.stderr.trim()).toBe("error");
		});

		it("passes env vars", async () => {
			const result = await sandbox.commands.run("echo $FOO", {
				envs: { FOO: "bar" },
			});
			expect(result.stdout.trim()).toBe("bar");
		});

		it("runs long-running command", async () => {
			const result = await sandbox.commands.run("sleep 1 && echo done");
			expect(result.stdout.trim()).toBe("done");
		});

		it("whoami returns admin", async () => {
			const result = await sandbox.commands.run("whoami");
			expect(result.stdout.trim()).toBe("admin");
		});
	});

	// ── Filesystem ─────────────────────────────────────────────

	describe("Filesystem", () => {
		it("writes and reads a file", async () => {
			await sandbox.files.write("/tmp/test.txt", "hello tart");
			const content = await sandbox.files.read("/tmp/test.txt");
			expect(content).toBe("hello tart");
		});

		it("lists directory entries", async () => {
			await sandbox.commands.run(
				"mkdir -p /tmp/testdir && touch /tmp/testdir/a.txt /tmp/testdir/b.txt",
			);
			const entries = await sandbox.files.list("/tmp/testdir");
			const names = entries.map((e) => e.name).sort();
			expect(names).toContain("a.txt");
			expect(names).toContain("b.txt");
		});

		it("reads file created by shell command via SDK", async () => {
			await sandbox.commands.run("echo -n 'from-cmd' > /tmp/cmd-file.txt");
			const content = await sandbox.files.read("/tmp/cmd-file.txt");
			expect(content).toBe("from-cmd");
		});
	});

	// ── envd-lite, ports, lifecycle ────────────────────────────

	describe("envd-lite, ports, and lifecycle", () => {
		const serveOk = (port: number) =>
			`while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok' | nc -l ${port}; done`;
		const viaHeaders = (
			id: string,
			port: number,
			headers: Record<string, string> = {},
		) =>
			fetch(`${opts.apiUrl}/`, {
				headers: {
					"E2b-Sandbox-Id": id,
					"E2b-Sandbox-Port": String(port),
					...headers,
				},
			});
		async function waitForOk(id: string, port: number) {
			for (let i = 0; i < 60; i++) {
				const res = await viaHeaders(id, port).catch(() => null);
				if (res?.status === 200) return res;
				await new Promise((r) => setTimeout(r, 500));
			}
			throw new Error(`port ${port} never answered`);
		}

		it("reports envd-lite's API version", async () => {
			const info = await Sandbox.getInfo(sandbox.sandboxId, opts);
			expect(info.envdVersion).toBe("0.5.3");
		});

		it("rejects envd requests without the access token", async () => {
			const res = await fetch(`${opts.apiUrl}/files?path=/tmp/test.txt`, {
				headers: { "E2b-Sandbox-Id": sandbox.sandboxId },
			});
			expect(res.status).toBe(401);
		});

		it("reports the VM's resource use", async () => {
			const [sample] = await sandbox.getMetrics();
			expect(sample?.cpuCount).toBeGreaterThan(0);
			expect(sample?.memTotal).toBeGreaterThan(0);
		});

		it("serves a port opened inside the VM", async () => {
			await sandbox.commands.run(serveOk(3000), { background: true });
			const res = await waitForOk(sandbox.sandboxId, 3000);
			expect(await res.text()).toBe("ok");
		});

		it("suspends on timeout keeping processes, and resumes on traffic", async (ctx) => {
			const resumable = await Sandbox.create("base", {
				...opts,
				timeoutMs: 30_000,
				lifecycle: { onTimeout: "pause", autoResume: true },
			});
			try {
				await resumable.commands.run(serveOk(3001), { background: true });
				await waitForOk(resumable.sandboxId, 3001);

				for (let i = 0; ; i++) {
					const info = await Sandbox.getInfo(resumable.sandboxId, opts);
					if (info.state === "paused") break;
					if (i > 120) throw new Error("the sandbox never paused");
					await new Promise((r) => setTimeout(r, 1000));
				}

				// Some hosts refuse to save VM state; tart then stops the VM, which
				// keeps its disk but not its processes. That is the host, not us.
				const vmState = spawnSync("tart", ["list", "--format", "json"], {
					encoding: "utf-8",
				}).stdout;
				const vm = (
					JSON.parse(vmState) as { Name: string; State: string }[]
				).find((v) => v.Name === `sandbox-${resumable.sandboxId}`);
				if (vm?.State === "stopped") {
					// The paused sandbox still resumes on traffic, from its disk.
					const echo = await resumable.commands.run("echo resumed");
					expect(echo.stdout.trim()).toBe("resumed");
					ctx.skip("this host cannot save Tart VM state (tart suspend fails)");
				}

				const res = await waitForOk(resumable.sandboxId, 3001);
				expect(await res.text()).toBe("ok");
				expect((await Sandbox.getInfo(resumable.sandboxId, opts)).state).toBe(
					"running",
				);
			} finally {
				await resumable.kill().catch(() => {});
			}
		});

		it("rejects a filesystem-only auto-pause, which Tart cannot do", async () => {
			await expect(
				Sandbox.create("base", {
					...opts,
					lifecycle: { onTimeout: { action: "pause", keepMemory: false } },
				} as never),
			).rejects.toThrow(/autoPauseMemory: false on the tart backend/);
		});
	});

	// ── Cleanup ────────────────────────────────────────────────

	describe("Cleanup", () => {
		it("kills the sandbox", async () => {
			await sandbox.kill();
		});

		it("sandbox is no longer in the list after kill", async () => {
			const paginator = Sandbox.list(opts);
			const sandboxes = await paginator.nextItems();
			const found = sandboxes.find((s) => s.sandboxId === sandbox.sandboxId);
			expect(found).toBeUndefined();
		});
	});
});
