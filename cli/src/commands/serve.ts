import { randomBytes } from "node:crypto";
import { readConfig, writeConfig } from "../lib/config.ts";

export async function run(_args: string[]) {
  // If API_KEYS is already set (e.g. via docker-compose env), skip config file
  if (!process.env.API_KEYS) {
    let config = readConfig();

    if (!config) {
      const apiKey = `e2b_${randomBytes(20).toString("hex")}`;
      config = { apiKey };
      writeConfig(config);
      console.log(`API Key: ${apiKey}\n`);
    }

    process.env.API_KEYS = config.apiKey;
    if (config.backend) {
      process.env.SANDBOX_BACKEND = config.backend;
    }
  }

  // Import starts the server via Bun's default export
  await import("../server/index.ts");
}
