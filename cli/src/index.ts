#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

const commands: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  init: () => import("./commands/init.ts"),
  serve: () => import("./commands/serve.ts"),
  status: () => import("./commands/status.ts"),
};

function printHelp() {
  console.log(`Usage: sandbox <command>

Commands:
  init      Interactive first-time setup
  serve     Run the control plane server
  status    Show stack health and running sandboxes`);
}

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

const loader = commands[command];
if (!loader) {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

try {
  const mod = await loader();
  await mod.run(args);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
