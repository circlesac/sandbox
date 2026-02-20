import { createMiddleware } from "hono/factory";
import { config } from "../config.ts";

export const authMiddleware = createMiddleware(async (c, next) => {
  const apiKey = c.req.header("X-API-Key") ?? c.req.header("x-api-key");

  if (!apiKey || !config.apiKeys.includes(apiKey)) {
    return c.json(
      { error: "unauthorized", message: "Unauthorized, please check your credentials." },
      401,
    );
  }

  await next();
});
