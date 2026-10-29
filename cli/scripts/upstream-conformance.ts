// Runs the API and envd integration tests of e2b-dev/runtime against a local
// control plane and prints which pass, fail, or skip. Failures outside the
// committed baseline are expected for unimplemented E2B Cloud features; baseline
// regressions exit 1.
//
//   bun run test:upstream [--commit <sha>] [--out <report.md>] [--run <go test -run regex>] [--update-baseline]
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dir exists only under Bun; the unit tests import this file
// under Node.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = join(scriptDir, "..");
const baselinePath = join(scriptDir, "upstream-baseline.txt");
const args = process.argv.slice(2);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const commit = option("--commit") ?? "518278060a154124a80d98f37253f8af77baf478";
const out = option("--out");
const runFilter = option("--run") ?? "";
const updateBaseline = args.includes("--update-baseline");
const SUITES = [
	"./internal/tests/api/",
	"./internal/tests/api/sandboxes/",
	"./internal/tests/api/metrics/",
	"./internal/tests/api/volumes/",
	"./internal/tests/envd/",
];
const API_KEY = "e2b_0000000000000000000000000000000000000000";

const BASELINE_HEADER = `# Upstream integration tests expected to pass against this control plane.
# One entry per line: "<package> <TestName>" (same keys as the conformance report).
# Regenerate from a full run with: bun run test:upstream --update-baseline
`;

/** Lines in upstream-baseline.txt that are expected passing tests. */
export function parseBaseline(content: string): Set<string> {
	const keys = new Set<string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		keys.add(trimmed);
	}
	return keys;
}

/** Compare a run to the baseline; optional runFilter limits which baseline rows are checked. */
export function compareUpstreamBaseline(
	baseline: ReadonlySet<string>,
	results: ReadonlyMap<string, string>,
	runFilter: string,
): { regressions: string[]; improvements: string[] } {
	const filteredRun = runFilter.length > 0;
	const regressions: string[] = [];
	for (const key of [...baseline].sort()) {
		if (filteredRun && !results.has(key)) continue;
		if (!results.get(key)?.startsWith("pass")) regressions.push(key);
	}
	const improvements: string[] = [];
	for (const [key, result] of results) {
		if (!result.startsWith("pass") || baseline.has(key)) continue;
		improvements.push(key);
	}
	improvements.sort();
	return { regressions, improvements };
}

export function formatBaseline(passingKeys: Iterable<string>): string {
	const lines = [...passingKeys].sort();
	return `${BASELINE_HEADER}\n${lines.join("\n")}\n`;
}

function must(cmd: string, cmdArgs: string[], cwd?: string) {
	const result = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

async function main() {
	// 1. A checkout of e2b-dev/runtime at the pinned commit, cached between runs.
	const repo = join(homedir(), ".cache", "sandbox", "e2b-runtime");
	if (!existsSync(join(repo, ".git"))) {
		mkdirSync(repo, { recursive: true });
		must("git", ["init", "-q", repo]);
		must("git", [
			"-C",
			repo,
			"remote",
			"add",
			"origin",
			"https://github.com/e2b-dev/runtime.git",
		]);
	}
	must("git", ["-C", repo, "fetch", "-q", "--depth", "1", "origin", commit]);
	must("git", ["-C", repo, "checkout", "-q", "--detach", "FETCH_HEAD"]);

	// 2. A control plane on a free port. Upstream's test cleanups run on an
	// already-cancelled context, so some sandboxes and snapshots outlive their
	// tests; note what exists now to remove what the run leaves behind.
	const imagesBefore = new Set(savedImages());
	const startedAt = new Date().toISOString();
	const port = await freePort();
	const url = `http://localhost:${port}`;
	const server = spawn("bun", ["run", "src/server/index.ts"], {
		cwd: cliDir,
		env: {
			...process.env,
			PORT: String(port),
			ENVD_PROXY_PORT: String(port),
			API_KEYS: API_KEY,
		},
		stdio: "ignore",
	});
	try {
		for (let i = 0; ; i++) {
			if ((await fetch(`${url}/health`).catch(() => null))?.ok) break;
			if (i > 60) throw new Error("control plane did not start");
			await new Promise((r) => setTimeout(r, 500));
		}

		// 3. The upstream suites, as JSON events. Tests that read E2B's own
		// Postgres panic without it and abort their whole package, so skip them.
		const dbTests = testsNeedingDatabase(join(repo, "tests", "integration"));
		// One package at a time and a few tests at once: upstream sizes its
		// parallelism for a cloud cluster, and a laptop's Docker would time out.
		const goArgs = [
			"test",
			"-json",
			"-count=1",
			"-p=1",
			"-parallel=4",
			"-timeout",
			"60m",
			...SUITES,
		];
		if (runFilter) goArgs.push("-run", runFilter);
		if (dbTests.length > 0) goArgs.push("-skip", `^(${dbTests.join("|")})$`);
		const test = spawnSync("go", goArgs, {
			cwd: join(repo, "tests", "integration"),
			env: {
				...process.env,
				TESTS_API_SERVER_URL: url,
				TESTS_ENVD_PROXY: url,
				TESTS_SANDBOX_TEMPLATE_ID: "base",
				TESTS_E2B_API_KEY: API_KEY,
			},
			maxBuffer: 1024 * 1024 * 1024,
			encoding: "utf-8",
		});

		// 4. One line per top-level test: package, name, result.
		const results = new Map<string, string>();
		for (const line of test.stdout.split("\n")) {
			if (!line.startsWith("{")) continue;
			const event = JSON.parse(line) as {
				Action: string;
				Package?: string;
				Test?: string;
			};
			if (!event.Test || event.Test.includes("/")) continue;
			if (["pass", "fail", "skip"].includes(event.Action)) {
				const pkg = (event.Package ?? "").replace(/.*\/internal\/tests\//, "");
				results.set(`${pkg} ${event.Test}`, event.Action);
			}
		}
		if (results.size === 0) {
			console.error(test.stderr || test.stdout);
			throw new Error("go test produced no results");
		}

		for (const name of dbTests) {
			const pkg = [...results.keys()]
				.find((k) => k.endsWith(` ${name}`))
				?.split(" ")[0];
			results.set(`${pkg ?? "?"} ${name}`, "skip (needs E2B's Postgres)");
		}
		const rows = [...results.entries()].sort(([a], [b]) => a.localeCompare(b));
		const count = (action: string) =>
			rows.filter(([, r]) => r.startsWith(action)).length;
		const report = [
			`e2b-dev/runtime@${commit.slice(0, 7)} against this server: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`,
			"",
			"| Package | Test | Result |",
			"| --- | --- | --- |",
			...rows.map(([key, result]) => {
				const [pkg, name] = key.split(" ");
				return `| ${pkg} | ${name} | ${result} |`;
			}),
		].join("\n");
		console.log(report);
		if (out) writeFileSync(out, `${report}\n`);

		const passing = rows
			.filter(([, r]) => r.startsWith("pass"))
			.map(([key]) => key);
		if (updateBaseline) {
			writeFileSync(baselinePath, formatBaseline(passing));
			return;
		}

		const baseline = parseBaseline(readFileSync(baselinePath, "utf-8"));
		const { regressions, improvements } = compareUpstreamBaseline(
			baseline,
			results,
			runFilter,
		);
		if (improvements.length > 0) {
			console.error(
				`Improvements (${improvements.length} tests passed but are not in the baseline):`,
			);
			for (const key of improvements) console.error(`  + ${key}`);
		}
		if (regressions.length > 0) {
			console.error(
				`Regressions (${regressions.length} baseline tests did not pass):`,
			);
			for (const key of regressions) {
				const result = results.get(key) ?? "missing";
				console.error(`  - ${key} (${result})`);
			}
			process.exitCode = 1;
		}
	} finally {
		await removeLeftovers(url, startedAt, imagesBefore).catch((err) =>
			console.error(`cleanup: ${err}`),
		);
		server.kill("SIGTERM");
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

/** Image IDs of snapshots and forks, which are Docker images on this backend. */
function savedImages(): string[] {
	const ids = ["label=e2b.snapshot=true", "label=e2b.fork-of"].flatMap(
		(filter) =>
			spawnSync("docker", ["images", "-q", "--filter", filter], {
				encoding: "utf-8",
			}).stdout.split("\n"),
	);
	return [...new Set(ids.filter(Boolean))];
}

/** Kills the sandboxes this run started and removes the images it saved. */
async function removeLeftovers(
	url: string,
	startedAt: string,
	imagesBefore: ReadonlySet<string>,
) {
	const headers = { "X-API-Key": API_KEY };
	const res = await fetch(
		`${url}/v2/sandboxes?startedAfter=${encodeURIComponent(startedAt)}`,
		{ headers },
	);
	const sandboxes = res.ok
		? ((await res.json()) as { sandboxID: string }[])
		: [];
	await Promise.allSettled(
		sandboxes.map((s) =>
			fetch(`${url}/sandboxes/${s.sandboxID}`, { method: "DELETE", headers }),
		),
	);
	const images = savedImages().filter((id) => !imagesBefore.has(id));
	if (images.length > 0) {
		spawnSync("docker", ["rmi", "-f", ...images], { stdio: "ignore" });
	}
	console.error(
		`Removed ${sandboxes.length} leftover sandboxes and ${images.length} snapshot or fork images`,
	);
}

/**
 * Top-level tests in the suites that reach setup.GetTestDBClient, directly
 * or through helpers in the same package.
 */
function testsNeedingDatabase(root: string): string[] {
	const names: string[] = [];
	for (const suite of SUITES) {
		const dir = join(root, suite);
		const bodies = new Map<string, string>();
		for (const file of readdirSync(dir).filter((f) => f.endsWith("_test.go"))) {
			const source = readFileSync(join(dir, file), "utf-8");
			const parts = source.split(/^func (?:\([^)]*\) )?(\w+)\(/m);
			for (let i = 1; i + 1 < parts.length; i += 2) {
				bodies.set(parts[i] ?? "", parts[i + 1] ?? "");
			}
		}
		const needs = new Set(
			[...bodies]
				.filter(([, body]) => body.includes("GetTestDBClient("))
				.map(([n]) => n),
		);
		for (let grew = true; grew; ) {
			grew = false;
			for (const [name, body] of bodies) {
				if (needs.has(name)) continue;
				if ([...needs].some((n) => new RegExp(`\\b${n}\\(`).test(body))) {
					needs.add(name);
					grew = true;
				}
			}
		}
		names.push(...[...needs].filter((n) => /^Test/.test(n)));
	}
	return names;
}
