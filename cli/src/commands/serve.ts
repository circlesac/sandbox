import { randomBytes } from "node:crypto";
import { readConfig, writeConfig } from "../lib/config.ts";

export async function run(_args: string[]) {
  let config = readConfig();

  if (!config) {
    const apiKey = `sk-sandbox-${randomBytes(24).toString("hex")}`;
    config = { apiKey };
    writeConfig(config);
    console.log(`API Key: ${apiKey}\n`);
  }

  // Set env vars for the server config module
  process.env.API_KEYS = config.apiKey;
  if (config.backend) {
    process.env.SANDBOX_BACKEND = config.backend;
  }

  // Import starts the server via Bun's default export
  await import("../server/index.ts");
}
