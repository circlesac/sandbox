import type { Context } from "hono";
import type { BackendMap, ContainerBackend } from "./backend.ts";

const portCache = new Map<string, number>();
const tokenCache = new Map<string, string>(); // accessToken → sandboxId

export function registerToken(accessToken: string, sandboxId: string): void {
  tokenCache.set(accessToken, sandboxId);
}

export function clearPortCache(sandboxId?: string): void {
  if (sandboxId) {
    portCache.delete(sandboxId);
    for (const [token, id] of tokenCache) {
      if (id === sandboxId) tokenCache.delete(token);
    }
  } else {
    portCache.clear();
    tokenCache.clear();
  }
}

export function resolveSandboxByToken(accessToken: string): string | undefined {
  return tokenCache.get(accessToken);
}

export function parseEnvdHostname(
  host: string,
): { sandboxId: string } | null {
  // Pattern: {port}-{sandboxId}.{domain}
  // Example: 49983-sbx-abc123def456.sandbox.circles.dev
  const match = host.match(/^\d+-(sbx-[a-zA-Z0-9_-]+)\./);
  if (!match?.[1]) return null;
  return { sandboxId: match[1] };
}

/**
 * Resolve a sandbox ID, falling back to the single running sandbox when the
 * given ID doesn't match any container (e.g. the E2B SDK sends
 * "debug_sandbox_id" in debug mode).
 */
export async function resolveSandboxId(
  sandboxId: string,
  backends: BackendMap,
): Promise<string | null> {
  const all = [backends.linux, backends.macos].filter(
    (b): b is ContainerBackend => b != null,
  );

  // Fast path: exact match across all backends
  for (const b of all) {
    const info = await b.inspectSandbox(sandboxId);
    if (info && info.state === "running") return sandboxId;
  }

  // Fallback: if only one sandbox is running across all backends, use it.
  // This handles E2B SDK debug mode which sends sandboxId="debug_sandbox_id".
  const results = await Promise.all(all.map((b) => b.listSandboxes({ state: "running" })));
  const running = results.flat();
  if (running.length === 1 && running[0]) return running[0].sandboxId;

  return null;
}

export async function handleProxyRequest(
  c: Context,
  backends: BackendMap,
  sandboxIdOverride?: string,
): Promise<Response> {
  let sandboxId = sandboxIdOverride;

  if (!sandboxId) {
    const host = c.req.header("host") ?? "";
    const parsed = parseEnvdHostname(host);
    if (!parsed) {
      return c.json({ code: 502, message: "Invalid sandbox hostname" }, 502);
    }
    sandboxId = parsed.sandboxId;
  }

  // Resolve host port (cached)
  let hostPort = portCache.get(sandboxId);
  if (!hostPort) {
    // Try exact match first, then fallback resolution
    const resolved = await resolveSandboxId(sandboxId, backends);
    if (!resolved) {
      return c.json(
        { code: 502, message: `Sandbox ${sandboxId} not available` },
        502,
      );
    }
    // If resolved to a different ID (fallback), update sandboxId
    if (resolved !== sandboxId) {
      sandboxId = resolved;
      hostPort = portCache.get(sandboxId);
    }
    if (!hostPort) {
      // Search all backends for this sandbox
      const all = [backends.linux, backends.macos].filter(
        (b): b is ContainerBackend => b != null,
      );
      for (const b of all) {
        const info = await b.inspectSandbox(sandboxId);
        if (info && info.state === "running") {
          hostPort = info.hostPort;
          portCache.set(sandboxId, hostPort);
          break;
        }
      }
      if (!hostPort) {
        return c.json(
          { code: 502, message: `Sandbox ${sandboxId} not available` },
          502,
        );
      }
    }
  }

  // Build target URL
  const url = new URL(c.req.url);
  const targetUrl = `http://localhost:${hostPort}${url.pathname}${url.search}`;

  // Forward headers, replacing Host
  const headers = new Headers(c.req.raw.headers);
  headers.set("host", `localhost:${hostPort}`);
  // Prevent double-decompression: Bun's fetch auto-decompresses gzip
  // but keeps Content-Encoding header, confusing the downstream client
  headers.delete("accept-encoding");

  try {
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body:
        c.req.method !== "GET" && c.req.method !== "HEAD"
          ? c.req.raw.body
          : undefined,
      duplex: "half",
    });

    // Stream response back — strip content-encoding since Bun's fetch
    // auto-decompresses but keeps the header, causing double-decompress
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    // Connection failed — invalidate cache and retry once
    portCache.delete(sandboxId);
    return c.json(
      { code: 502, message: `Failed to reach sandbox ${sandboxId}` },
      502,
    );
  }
}
