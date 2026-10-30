import { config } from "./config.ts";
import { createApp } from "./app.ts";
import {
	handleProxyRequest,
	resolveDebugSandbox,
	resolveSandboxByToken,
} from "./services/proxy.ts";
import { Hono } from "hono";

const { app, backends, sandboxService } = createApp();

// Download the default template before the first create needs it.
backends.linux.prefetchImage?.("base");

// Timeouts survive restarts: re-arm them from persisted state, and handle
// the ones that expired while the server was down.
async function reconcileTtls() {
	const count = await sandboxService.reconcile();
	console.log(`Reconciled TTLs for ${count} sandbox(es)`);
}

reconcileTtls().catch(console.error);

// Periodic reconciliation — clean stopped VMs + expired TTLs every 30s
setInterval(async () => {
	try {
		// listSandboxes triggers stopped VM cleanup in TartBackend
		const allBackends = [backends.linux, backends.macos].filter(Boolean);
		await Promise.all(allBackends.map((b) => b?.listSandboxes()));
		await reconcileTtls();
	} catch (e) {
		console.error("Reconciliation error:", e);
	}
}, 30_000);

// Main control plane + data plane proxy (port 49982)
console.log(`Control plane listening on :${config.port}`);

// Both listeners carry authenticated long-lived PTY streams. Bun's default
// idle timeout would terminate a healthy session while it waits for input.
Bun.serve({
	port: config.port,
	idleTimeout: 0,
	fetch: app.fetch,
});

// Envd proxy listener (port 49983)
// The E2B SDK in debug mode connects directly to localhost:49983.
// This listener proxies those requests to the correct container's mapped port.
if (config.port !== config.envdProxyPort) {
	const envdProxy = new Hono();
	envdProxy.all("*", async (c) => {
		// Resolve sandbox from E2b-Sandbox-Id header, access token, or the
		// single running sandbox (the SDK's debug mode sends a placeholder ID)
		let sandboxId = c.req.header("E2b-Sandbox-Id") ?? undefined;
		if (!sandboxId) {
			const accessToken = c.req.header("X-Access-Token");
			if (accessToken) {
				sandboxId = resolveSandboxByToken(accessToken);
			}
		}

		const finalId = await resolveDebugSandbox(
			sandboxId,
			sandboxService,
			c.req.header("X-Access-Token"),
		);
		if (!finalId) {
			return c.json({ code: 502, message: "No running sandbox found" }, 502);
		}

		return handleProxyRequest(c, sandboxService, {
			sandboxId: finalId,
			port: config.envdPort,
		});
	});

	Bun.serve({
		port: config.envdProxyPort,
		idleTimeout: 0,
		fetch: envdProxy.fetch,
	});

	console.log(`Envd proxy listening on :${config.envdProxyPort}`);
}
