import { readConfig } from "../lib/config.ts";
import { exec } from "../lib/exec.ts";
import { isDockerRunning } from "../lib/checks.ts";

export async function run(_args: string[]) {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run 'sandbox init' first.");
    process.exit(1);
  }

  if (!isDockerRunning()) {
    console.error("Docker is not running.");
    process.exit(1);
  }

  const { stdout: countOutput } = exec(
    `docker ps --filter "label=e2b.sandbox-id" -q`,
  );
  const sandboxCount = countOutput.trim()
    ? countOutput.trim().split("\n").length
    : 0;

  let health = "unreachable";
  try {
    const res = await fetch("http://localhost:49982/health", {
      signal: AbortSignal.timeout(2000),
    });
    health = res.ok ? "healthy" : `unhealthy (${res.status})`;
  } catch {
    // unreachable
  }

  console.log(`Control plane:  ${health}`);
  console.log(`Sandboxes:      ${sandboxCount}`);
}
