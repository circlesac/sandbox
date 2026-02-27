import { readConfig } from "../lib/config.ts";

export async function run(_args: string[]) {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run 'sandbox init' first.");
    process.exit(1);
  }

  // Set env vars for the server config module
  process.env.API_KEYS = config.apiKey;
  if (config.backend) {
    process.env.SANDBOX_BACKEND = config.backend;
  }

  // Import starts the server via Bun's default export
  await import("../server/index.ts");
}
