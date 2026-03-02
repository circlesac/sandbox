import { config } from "../config.ts";
import { pollUntil } from "../lib/retry.ts";

export class EnvdService {
  async waitForHealth(hostPort: number): Promise<void> {
    await pollUntil(
      async () => {
        const res = await fetch(`http://localhost:${hostPort}/health`);
        if (!res.ok && res.status !== 204) {
          throw new Error(`envd health check returned ${res.status}`);
        }
      },
      {
        timeoutMs: config.envdHealthTimeoutMs,
        intervalMs: config.envdHealthIntervalMs,
      },
    );
  }

  async init(
    hostPort: number,
    opts: {
      accessToken?: string;
      defaultUser?: string;
      envVars?: Record<string, string>;
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      defaultUser: opts.defaultUser ?? config.defaultUser,
      envVars: opts.envVars ?? {},
    };
    if (opts.accessToken) {
      payload.accessToken = opts.accessToken;
    }
    const res = await fetch(`http://localhost:${hostPort}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`envd /init failed (${res.status}): ${text}`);
    }
  }
}
