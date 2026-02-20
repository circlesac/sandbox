import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { configExists, writeConfig, SANDBOX_DIR } from "../lib/config.ts";
import { isDockerInstalled, isDockerRunning } from "../lib/checks.ts";

function prompt(question: string, defaultValue?: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise<string>((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function run(_args: string[]) {
  if (configExists()) {
    const answer = await prompt("Already initialized. Re-initialize? (y/N)");
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  // 1. Check Docker
  if (!isDockerInstalled()) {
    console.error("Docker not found. Install one of:");
    console.error("  brew install --cask orbstack");
    console.error("  brew install --cask docker");
    process.exit(1);
  }

  if (!isDockerRunning()) {
    console.error("Docker is installed but not running. Start it and try again.");
    process.exit(1);
  }

  // 2. Generate API key
  const apiKey = `sk-sandbox-${randomBytes(24).toString("hex")}`;

  // 3. Write config
  const config = { apiKey };

  writeConfig(config);

  console.log("\nSandbox initialized!");
  console.log(`  Config:   ${SANDBOX_DIR}`);
  console.log(`  API Key:  ${apiKey}`);
  console.log("\nRun 'sandbox serve' to start the control plane.");
}
