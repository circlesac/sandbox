// Runs the integration suite of one sandbox provider, failing when the
// provider is not set up on this machine instead of silently skipping it.
// `local` runs the unit tests, every provider this machine can run, and the
// E2B SDK matrix, then prints which providers were unavailable and why.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type Provider, providers } from "../test/integration/providers.ts";

const cliDir = join(import.meta.dir, "..");

function run(command: string, args: string[]): boolean {
	return (
		spawnSync(command, args, { cwd: cliDir, stdio: "inherit" }).status === 0
	);
}

const target = process.argv[2];

if (target && target in providers) {
	const suite = providers[target as Provider];
	const missing = suite.missing();
	if (missing) {
		console.error(`test:${target} cannot run: ${missing}`);
		process.exit(1);
	}
	process.exit(run("bunx", ["vitest", "run", ...suite.specs]) ? 0 : 1);
}

if (target !== "local") {
	console.error(
		`usage: test-providers.ts <${Object.keys(providers).join("|")}|local>`,
	);
	process.exit(2);
}

const results: { name: string; outcome: string }[] = [];
const record = (name: string, passed: boolean) =>
	results.push({ name, outcome: passed ? "pass" : "FAIL" });

record("unit", run("bunx", ["vitest", "run", "test/unit"]));
for (const [name, suite] of Object.entries(providers)) {
	const missing = suite.missing();
	if (missing) {
		results.push({ name, outcome: `not available: ${missing}` });
		continue;
	}
	record(name, run("bunx", ["vitest", "run", ...suite.specs]));
	if (name === "docker")
		record("sdk-matrix", run("bun", ["run", "scripts/sdk-matrix.ts"]));
}

// envd-lite is the Tart agent; its Go tests run anywhere Go and protoc are installed.
const goTools = [
	"go",
	"protoc",
	"protoc-gen-go",
	"protoc-gen-connect-go",
].filter(
	(tool) => spawnSync("which", [tool], { stdio: "ignore" }).status !== 0,
);
if (goTools.length > 0) {
	results.push({
		name: "envd-lite",
		outcome: `not available: missing ${goTools.join(", ")}`,
	});
} else {
	record("envd-lite", run("bun", ["run", "test:envd-lite"]));
}

console.log("\nLocal test summary");
for (const { name, outcome } of results)
	console.log(`  ${name.padEnd(10)} ${outcome}`);
if (results.some((r) => r.outcome === "FAIL")) process.exit(1);
