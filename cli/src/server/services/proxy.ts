import type { Context } from "hono";
import type { ContainerBackend } from "./backend.ts";

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

export async function handleProxyRequest(
  c: Context,
  backend: ContainerBackend,
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
    const info = await backend.inspectSandbox(sandboxId);
    if (!info || info.state !== "running") {
      return c.json(
        { code: 502, message: `Sandbox ${sandboxId} not available` },
        502,
      );
    }
    hostPort = info.hostPort;
    portCache.set(sandboxId, hostPort);
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
