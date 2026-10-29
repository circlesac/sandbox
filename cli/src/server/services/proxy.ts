import { posix } from "node:path";
import type { Context } from "hono";
import { config } from "../config.ts";
import { UnsupportedError } from "../errors.ts";
import type { SandboxInfo } from "../types.ts";
import type { ContainerBackend, ProxyTarget } from "./backend.ts";
import { type SandboxLifecycle, verifyFileSignature } from "./lifecycle.ts";

/**
 * envd routes only the control plane may call, as e2b-dev/runtime's proxy
 * lists them. The control plane reaches envd directly, so through a sandbox
 * URL these have no legitimate caller.
 */
const INTERNAL_ENVD_PATHS = new Set([
	"/collapse",
	"/freeze",
	"/fsfreeze",
	"/fsthaw",
	"/init",
	"/unfreeze",
	"/upgrade",
]);

/** What the proxy needs from the sandbox service. */
export interface ProxySandboxes {
	locate(
		sandboxId: string,
	): Promise<{ info: SandboxInfo; backend: ContainerBackend } | null>;
	resumeForTraffic(sandboxId: string): Promise<boolean>;
	list(filters?: { state?: string }): Promise<{ sandboxID: string }[]>;
}

/** A request for one port of one sandbox. */
export interface ProxyRoute {
	sandboxId: string;
	port: number;
}

interface CachedRoute {
	target: ProxyTarget;
	accessToken: string;
	lifecycle: SandboxLifecycle;
	envdChecksAccessToken: boolean;
}

const routeCache = new Map<string, CachedRoute>(); // `${sandboxId}:${port}`
const tokenCache = new Map<string, string>(); // accessToken → sandboxId

export function registerToken(accessToken: string, sandboxId: string): void {
	tokenCache.set(accessToken, sandboxId);
}

/** Forgets where a sandbox's ports are, e.g. after a pause; its tokens stay. */
export function clearRoutes(sandboxId: string): void {
	for (const key of routeCache.keys()) {
		// Keys may carry an E2B client-ID suffix after the sandbox ID.
		if (key.startsWith(`${sandboxId}:`) || key.startsWith(`${sandboxId}-`)) {
			routeCache.delete(key);
		}
	}
}

/** Forgets a removed sandbox entirely, or everything when no ID is given. */
export function clearPortCache(sandboxId?: string): void {
	if (sandboxId) {
		clearRoutes(sandboxId);
		for (const [token, id] of tokenCache) {
			if (id === sandboxId) tokenCache.delete(token);
		}
	} else {
		routeCache.clear();
		tokenCache.clear();
	}
}

export function resolveSandboxByToken(accessToken: string): string | undefined {
	return tokenCache.get(accessToken);
}

/** `{port}-{sandboxId}.{domain}`, e.g. `3000-sbx-abc123.localhost:49982`. */
export function parseSandboxHost(host: string): ProxyRoute | null {
	const match = host.match(/^(\d+)-(sbx-[a-zA-Z0-9_-]+)\./);
	if (!match?.[1] || !match[2]) return null;
	return { port: Number(match[1]), sandboxId: match[2] };
}

/**
 * The E2B SDK's debug mode sends this ID; map it to the only running sandbox.
 * Any other unknown ID is an error, never another sandbox.
 */
const DEBUG_SANDBOX_ID = "debug_sandbox_id";

export async function resolveDebugSandbox(
	sandboxId: string | undefined,
	sandboxes: ProxySandboxes,
): Promise<string | null> {
	if (sandboxId && sandboxId !== DEBUG_SANDBOX_ID) return sandboxId;
	const running = await sandboxes.list({ state: "running" });
	return running.length === 1 && running[0] ? running[0].sandboxID : null;
}

function proxyError(c: Context, status: 401 | 403 | 502, message: string) {
	return c.json({ code: status, message }, status);
}

/** Checks the envd access token when the sandbox's own envd does not. */
function envdAuthorized(c: Context, route: CachedRoute): boolean {
	if (!route.lifecycle.secure || route.envdChecksAccessToken) return true;
	if (c.req.header("X-Access-Token") === route.accessToken) return true;

	// Signed file URLs (Sandbox.uploadUrl / downloadUrl) carry no header.
	const url = new URL(c.req.url);
	const signature = url.searchParams.get("signature");
	if (!signature || url.pathname !== "/files") return false;
	return verifyFileSignature({
		signature,
		path: url.searchParams.get("path") ?? "",
		operation: c.req.method === "GET" ? "read" : "write",
		user: url.searchParams.get("username") ?? "",
		accessToken: route.accessToken,
		expiration: url.searchParams.get("signature_expiration"),
	});
}

async function lookupRoute(
	c: Context,
	sandboxes: ProxySandboxes,
	route: ProxyRoute,
): Promise<CachedRoute | Response> {
	const key = `${route.sandboxId}:${route.port}`;
	const cached = routeCache.get(key);
	if (cached) return cached;

	// E2B hosts may end the sandbox ID with an old client ID:
	// <port>-<sandboxId>-<clientId>.<domain>, the client ID 8 hex digits.
	let id = route.sandboxId;
	let found = await sandboxes.locate(id);
	const withoutClientId = id.match(/^(.+)-[0-9a-f]{8}$/)?.[1];
	if (!found && withoutClientId) {
		found = await sandboxes.locate(withoutClientId);
		if (found) id = withoutClientId;
	}
	if (!found) {
		return proxyError(c, 502, `Sandbox ${id} not found`);
	}
	if (found.info.state !== "running") {
		if (!(await sandboxes.resumeForTraffic(id))) {
			return proxyError(
				c,
				502,
				`Sandbox ${id} is paused; resume it with Sandbox.connect()`,
			);
		}
		found = await sandboxes.locate(id);
		if (!found) {
			return proxyError(c, 502, `Sandbox ${id} not found`);
		}
	}

	let target: ProxyTarget | null;
	try {
		target = await found.backend.resolveTarget(id, route.port);
	} catch (err) {
		if (err instanceof UnsupportedError) return proxyError(c, 502, err.message);
		throw err;
	}
	if (!target) {
		return proxyError(
			c,
			502,
			`Port ${route.port} of sandbox ${id} is not reachable`,
		);
	}

	const entry: CachedRoute = {
		target,
		accessToken: found.info.accessToken,
		lifecycle: found.info.lifecycle,
		envdChecksAccessToken: found.backend.envdChecksAccessToken,
	};
	routeCache.set(key, entry);
	return entry;
}

export async function handleProxyRequest(
	c: Context,
	sandboxes: ProxySandboxes,
	route: ProxyRoute,
): Promise<Response> {
	const resolved = await lookupRoute(c, sandboxes, route);
	if (resolved instanceof Response) return resolved;

	if (route.port === config.envdPort) {
		// envd routes the decoded path, so check that, or "/%69nit" would pass;
		// trailing slashes go too, or "/init/" would.
		const requestPath =
			posix
				.normalize(safeDecode(new URL(c.req.url).pathname))
				.replace(/\/+$/, "") || "/";
		if (INTERNAL_ENVD_PATHS.has(requestPath)) {
			return c.json(
				{
					code: 404,
					message: `${requestPath} is reserved for the E2B control plane`,
				},
				404,
			);
		}
		if (!envdAuthorized(c, resolved)) {
			return proxyError(c, 401, "Missing or invalid sandbox access token");
		}
	} else if (
		resolved.lifecycle.trafficAccessToken &&
		c.req.header("e2b-traffic-access-token") !==
			resolved.lifecycle.trafficAccessToken
	) {
		return proxyError(
			c,
			403,
			"This sandbox does not allow public traffic; send its e2b-traffic-access-token",
		);
	}

	const { host, port } = resolved.target;
	const url = new URL(c.req.url);
	const targetUrl = `http://${host}:${port}${url.pathname}${url.search}`;

	// Forward headers, replacing Host
	const headers = new Headers(c.req.raw.headers);
	headers.set("host", `${host}:${port}`);
	// Prevent double-decompression: Bun's fetch auto-decompresses gzip
	// but keeps Content-Encoding header, confusing the downstream client
	headers.delete("accept-encoding");
	headers.delete("transfer-encoding");

	try {
		const response = await fetch(targetUrl, {
			method: c.req.method,
			headers,
			body:
				c.req.method !== "GET" && c.req.method !== "HEAD"
					? await c.req.raw.arrayBuffer()
					: undefined,
			duplex: "half",
		});

		// Bun's fetch decompresses an encoded body but keeps Content-Encoding
		// and the encoded length, so both go. Otherwise the length stays, and
		// the client can tell a body that was cut off.
		const responseHeaders = new Headers(response.headers);
		const decoded = responseHeaders.has("content-encoding");
		if (decoded) {
			responseHeaders.delete("content-encoding");
			responseHeaders.delete("content-length");
		}
		const sized = responseHeaders.has("content-length");

		return new Response(endOnUpstreamReset(response.body, sized), {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch {
		// The sandbox may have been paused or moved; look it up again next time.
		clearRoutes(route.sandboxId);
		return proxyError(
			c,
			502,
			`Failed to reach port ${route.port} of sandbox ${route.sandboxId}`,
		);
	}
}

/**
 * Passes a response body through. When the sandbox side drops the
 * connection, an open-ended stream (a long-running process's output when its
 * sandbox is killed) just ends; a body of declared length fails, so a
 * truncated file never reads as complete.
 */
function endOnUpstreamReset(
	body: ReadableStream<Uint8Array> | null,
	sized: boolean,
): ReadableStream<Uint8Array> | null {
	if (!body) return null;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				if (sized) controller.error(err);
				else controller.close();
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function safeDecode(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}
