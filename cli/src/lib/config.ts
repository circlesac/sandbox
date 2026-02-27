import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SANDBOX_DIR = join(homedir(), ".sandbox");
export const CONFIG_PATH = join(SANDBOX_DIR, "config.json");

export interface SandboxConfig {
  apiKey: string;
  backend?: "docker" | "shuru";
}

export function configExists() {
  return existsSync(CONFIG_PATH);
}

export function readConfig(): SandboxConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as SandboxConfig;
}

export function writeConfig(config: SandboxConfig) {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
