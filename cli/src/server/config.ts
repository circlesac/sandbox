export const config = {
  port: Number(process.env.PORT ?? 49982),
  apiKeys: (process.env.API_KEYS ?? "").split(",").filter(Boolean),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  defaultTimeoutSec: Number(process.env.DEFAULT_TIMEOUT_SEC ?? 300),
  maxTimeoutSec: Number(process.env.MAX_TIMEOUT_SEC ?? 3600),
  envdPort: 49983,
  envdHealthTimeoutMs: Number(process.env.ENVD_HEALTH_TIMEOUT_MS ?? 30000),
  envdHealthIntervalMs: 500,
  domain: process.env.DOMAIN ?? "sandbox.circles.dev",
  envdVersion: "0.5.3",
  defaultUser: "user",
};
