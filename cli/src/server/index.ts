import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { handleProxyRequest, resolveSandboxByToken, resolveSandboxId } from "./services/proxy.ts";
import { Hono } from "hono";

const { app, backends, sandboxService, ttlService } = createApp();

// TTL reconciliation on startup
async function reconcileTtls() {
  const allBackends = [backends.linux, backends.macos].filter(Boolean);
  const results = await Promise.all(allBackends.map((b) => b!.listSandboxes({ state: "running" })));
  const sandboxes = results.flat();
  for (const sb of sandboxes) {
    const elapsed = (Date.now() - new Date(sb.createdAt).getTime()) / 1000;
    const remaining = sb.timeoutSec - elapsed;
    if (remaining <= 0) {
      await sandboxService.kill(sb.sandboxId);
    } else {
      ttlService.start(sb.sandboxId, remaining, () => {
        sandboxService.kill(sb.sandboxId).catch(console.error);
      });
    }
  }
  console.log(`Reconciled TTLs for ${sandboxes.length} sandbox(es)`);
}

reconcileTtls().catch(console.error);

// Main control plane + data plane proxy (port 49982)
console.log(`Control plane listening on :${config.port}`);

Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

// Envd proxy listener (port 49983)
// The E2B SDK in debug mode connects directly to localhost:49983.
// This listener proxies those requests to the correct container's mapped port.
if (config.port !== config.envdProxyPort) {
  const envdProxy = new Hono();
  envdProxy.all("*", async (c) => {
    // Resolve sandbox from E2b-Sandbox-Id header, access token, or fallback
    let sandboxId = c.req.header("E2b-Sandbox-Id") ?? undefined;
    if (!sandboxId) {
      const accessToken = c.req.header("X-Access-Token");
      if (accessToken) {
        sandboxId = resolveSandboxByToken(accessToken);
      }
    }

    // Resolve to a real sandbox (handles "debug_sandbox_id" and missing IDs)
    const resolved = sandboxId
      ? await resolveSandboxId(sandboxId, backends)
      : null;

    // If still unresolved, try to find the single running sandbox
    const finalId = resolved ?? (await resolveSandboxId("", backends));

    if (!finalId) {
      return c.json(
        { code: 502, message: "No running sandbox found" },
        502,
      );
    }

    return handleProxyRequest(c, backends, finalId);
  });

  Bun.serve({
    port: config.envdProxyPort,
    fetch: envdProxy.fetch,
  });

  console.log(`Envd proxy listening on :${config.envdProxyPort}`);
}
