import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, SANDBOX_DIR } from "../lib/config.ts";

const LABEL = "com.sandbox.serve";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(SANDBOX_DIR, "logs");


function getBinaryPath(): string {
  // Prefer the linked binary in PATH
  try {
    const resolved = execSync("which sandbox", { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {}
  // Fallback to the bin in this project
  return join(import.meta.dir, "../../bin/sandbox");
}

function buildPlist(binaryPath: string): string {
  const config = readConfig();

  const envVars: Record<string, string> = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  if (config?.apiKey) envVars.API_KEYS = config.apiKey;
  if (config?.backend) envVars.SANDBOX_BACKEND = config.backend;

  // Forward relevant env vars if set
  for (const key of [
    "SANDBOX_MACOS_BACKEND",
    "DOCKER_SOCKET",
    "DEFAULT_TIMEOUT_SEC",
    "MAX_TIMEOUT_SEC",
    "ENVD_PROXY_PORT",
    "DOMAIN",
  ]) {
    if (process.env[key]) envVars[key] = process.env[key]!;
  }

  const envEntries = Object.entries(envVars)
    .map(
      ([k, v]) =>
        `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binaryPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(LOG_DIR, "sandbox.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(LOG_DIR, "sandbox.err.log"))}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function install() {
  if (process.platform !== "darwin") {
    console.error("Error: service install is only supported on macOS");
    process.exit(1);
  }

  if (existsSync(PLIST_PATH)) {
    console.error(`Service already installed at ${PLIST_PATH}`);
    console.error('Run "sandbox service uninstall" first to reinstall.');
    process.exit(1);
  }

  const binaryPath = getBinaryPath();
  const plist = buildPlist(binaryPath);

  // Ensure log directory exists
  mkdirSync(LOG_DIR, { recursive: true });

  // Ensure LaunchAgents directory exists
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  writeFileSync(PLIST_PATH, plist);
  console.log(`Created ${PLIST_PATH}`);

  execSync(`launchctl load ${PLIST_PATH}`);
  console.log(`Service loaded and started.`);
  console.log(`\nLogs:\n  stdout: ${join(LOG_DIR, "sandbox.out.log")}\n  stderr: ${join(LOG_DIR, "sandbox.err.log")}`);
}

function uninstall() {
  if (process.platform !== "darwin") {
    console.error("Error: service uninstall is only supported on macOS");
    process.exit(1);
  }

  if (!existsSync(PLIST_PATH)) {
    console.error("Service is not installed.");
    process.exit(1);
  }

  try {
    execSync(`launchctl unload ${PLIST_PATH}`);
    console.log("Service unloaded.");
  } catch {
    // May already be unloaded
  }

  unlinkSync(PLIST_PATH);
  console.log(`Removed ${PLIST_PATH}`);
}

function status() {
  if (process.platform !== "darwin") {
    console.error("Error: service status is only supported on macOS");
    process.exit(1);
  }

  if (!existsSync(PLIST_PATH)) {
    console.log("Service is not installed.");
    return;
  }

  try {
    const output = execSync(`launchctl list ${LABEL}`, { encoding: "utf-8" });
    console.log(`Service is installed at ${PLIST_PATH}\n`);
    console.log(output);
  } catch {
    console.log(`Service is installed at ${PLIST_PATH} but not currently loaded.`);
    console.log('Run "sandbox service install" to reload, or uninstall first.');
  }
}

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "install":
      install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "status":
      status();
      break;
    default:
      console.log(`Usage: sandbox service <install|uninstall|status>

Commands:
  install     Create LaunchAgent plist, load, and start the service
  uninstall   Unload and remove the LaunchAgent plist
  status      Show launchd service status`);
      if (subcommand) process.exit(1);
      break;
  }
}
