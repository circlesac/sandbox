import { tmpdir } from "node:os";
import {
	createWriteStream,
	existsSync,
	mkdtempSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const SERVER_INFO_PATH = "/tmp/sandbox-integration-test.json";
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
			// server not ready yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(
		`Server did not become healthy on :${port} within ${timeoutMs}ms`,
	);
}

let serverProcess: ChildProcess | undefined;

export default async function setup() {
	// Check Docker availability
	const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
	if (docker.status !== 0) {
		if (process.env.CI) {
			throw new Error(
				"[global-setup] Docker is required in CI; the integration suite would otherwise be skipped",
			);
		}
		console.log(
			"[global-setup] Docker not available — skipping integration server",
		);
		return;
	}

	const port = await findFreePort();

	// Spawn the server as a Bun subprocess
	const serverEntry = join(__dirname, "..", "src", "server", "index.ts");
	serverProcess = spawn("bun", ["run", serverEntry], {
		env: {
			...process.env,
			PORT: String(port),
			ENVD_PROXY_PORT: String(port),
			API_KEYS: TEST_API_KEY,
			// This server tests Docker. With Tart enabled it would treat the Tart
			// suite's VMs as orphans and delete them.
			SANDBOX_MACOS_BACKEND: "",
			// Never the user's ~/.sandbox state: a test server would overwrite it.
			SANDBOX_STATE_DIR: mkdtempSync(join(tmpdir(), "sandbox-state-")),
		},
		stdio: "pipe",
	});

	serverProcess.stderr?.on("data", (data: Buffer) => {
		process.stderr.write(`[server] ${data}`);
	});
	// Its request log, kept for diagnosing a failure: tmpdir()/sandbox-integration-server.log
	serverProcess.stdout?.pipe(
		createWriteStream(join(tmpdir(), "sandbox-integration-server.log")),
	);

	try {
		await waitForHealth(port);
	} catch (err) {
		// Do not leave a server running that no teardown will stop.
		serverProcess.kill("SIGTERM");
		serverProcess = undefined;
		throw err;
	}

	writeFileSync(
		SERVER_INFO_PATH,
		JSON.stringify({ port, apiKey: TEST_API_KEY }),
	);
	console.log(`[global-setup] Integration server on :${port}`);

	return async function teardown() {
		if (serverProcess) {
			serverProcess.kill("SIGTERM");
			serverProcess = undefined;
		}
		if (existsSync(SERVER_INFO_PATH)) unlinkSync(SERVER_INFO_PATH);
		console.log("[global-setup] Integration server stopped");
	};
}
