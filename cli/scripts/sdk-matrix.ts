// Runs the Docker integration suites against the lowest supported E2B SDK (the floor of
// the devDependency range) and the latest release, or against the versions
// given as arguments. Each version is installed into its own temporary
// directory, so the lockfile is never rewritten.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providers } from "../test/integration/providers.ts";

const cliDir = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8"));

async function defaultVersions(): Promise<string[]> {
	const lowest = String(pkg.devDependencies.e2b).replace(/^[\^~]/, "");
	const res = await fetch("https://registry.npmjs.org/e2b/latest");
	if (!res.ok)
		throw new Error(`npm registry returned HTTP ${res.status} for e2b@latest`);
	const { version: latest } = (await res.json()) as { version: string };
	return [...new Set([lowest, latest])];
}

const versions =
	process.argv.length > 2 ? process.argv.slice(2) : await defaultVersions();
const results: { version: string; passed: boolean }[] = [];

for (const version of versions) {
	const dir = mkdtempSync(join(tmpdir(), `e2b-sdk-${version}-`));
	try {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ private: true, dependencies: { e2b: version } }),
		);
		const install = spawnSync("bun", ["install", "--silent"], {
			cwd: dir,
			stdio: "inherit",
		});
		const entry = join(dir, "node_modules", "e2b", "dist", "index.mjs");
		if (install.status !== 0 || !existsSync(entry)) {
			throw new Error(`could not install e2b@${version}`);
		}

		console.log(`\n=== E2B SDK ${version} ===`);
		const run = spawnSync(
			"bunx",
			["vitest", "run", ...providers.docker.specs],
			{
				cwd: cliDir,
				stdio: "inherit",
				env: { ...process.env, E2B_SDK_ENTRY: entry },
			},
		);
		results.push({ version, passed: run.status === 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\nE2B SDK matrix");
for (const { version, passed } of results) {
	console.log(`  ${passed ? "pass" : "FAIL"}  e2b@${version}`);
}
if (results.some((r) => !r.passed)) process.exit(1);
