import { readConfig } from "../lib/config.ts";
import { exec } from "../lib/exec.ts";
import { isDockerRunning } from "../lib/checks.ts";

export async function run(_args: string[]) {
  const config = readConfig();
  if (!config) {
    console.log("Control plane:  not configured");
    console.log("Sandboxes:      -");
    console.log("\nRun 'sandbox serve' to get started.");
    return;
  }

  const backend = config.backend ?? "docker";

  if (backend === "docker" && !isDockerRunning()) {
    console.error("Docker is not running.");
    process.exit(1);
  }

  let sandboxCount: number | null = null;

  if (backend === "docker") {
    const { stdout: countOutput } = exec(
      `docker ps --filter "label=e2b.sandbox-id" -q`,
    );
    sandboxCount = countOutput.trim()
      ? countOutput.trim().split("\n").length
      : 0;
  }

  let health = "unreachable";
  try {
    const res = await fetch("http://localhost:49982/health", {
      signal: AbortSignal.timeout(2000),
    });
    health = res.ok ? "healthy" : `unhealthy (${res.status})`;
  } catch {
    // unreachable
  }

  if (backend === "shuru" && health === "healthy") {
    try {
      const res = await fetch("http://localhost:49982/sandboxes", {
        headers: { "X-API-Key": config.apiKey },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const sandboxes = (await res.json()) as unknown[];
        sandboxCount = sandboxes.length;
      }
    } catch {
      // leave as null
    }
  }

  console.log(`Control plane:  ${health}`);
  console.log(`Backend:        ${backend}`);
  console.log(`Sandboxes:      ${sandboxCount ?? "-"}`);
}
