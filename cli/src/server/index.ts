import { config } from "./config.ts";
import { createApp } from "./app.ts";

const { app, dockerService, sandboxService, ttlService } = createApp();

// TTL reconciliation on startup
async function reconcileTtls() {
  const sandboxes = await dockerService.listSandboxes({ state: "running" });
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

console.log(`Control plane listening on :${config.port}`);

Bun.serve({
  port: config.port,
  fetch: app.fetch,
});
