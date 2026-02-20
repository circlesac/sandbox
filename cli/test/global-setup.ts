import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const SERVER_INFO_PATH = "/tmp/sandbox-integration-test.json";
const TEST_API_KEY = "sk-test-integration";

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
  throw new Error(`Server did not become healthy on :${port} within ${timeoutMs}ms`);
}

let serverProcess: ChildProcess | undefined;

export default async function setup() {
  // Check Docker availability
  const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (docker.status !== 0) {
    console.log("[global-setup] Docker not available — skipping integration server");
    return;
  }

  const port = await findFreePort();

  // Spawn the server as a Bun subprocess
  const serverEntry = join(__dirname, "..", "src", "server", "index.ts");
  serverProcess = spawn("bun", ["run", serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      API_KEYS: TEST_API_KEY,
    },
    stdio: "pipe",
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[server] ${data}`);
  });

  await waitForHealth(port);

  writeFileSync(SERVER_INFO_PATH, JSON.stringify({ port, apiKey: TEST_API_KEY }));
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
