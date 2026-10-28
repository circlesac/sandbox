// Runs the API and envd integration tests of e2b-dev/runtime against a local
// control plane and prints which pass, fail, or skip. Many test features this
// server deliberately lacks (Firecracker snapshots, egress rules, volumes), so
// failures are reported, not treated as an error.
//
//   bun run test:upstream [--commit <sha>] [--out <report.md>] [--run <go test -run regex>]
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
import { join } from "node:path";

const cliDir = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const commit = option("--commit") ?? "518278060a154124a80d98f37253f8af77baf478";
const out = option("--out");
// Not after "--": bun run drops it.
const runFilter = option("--run") ?? "";
const SUITES = [
	"./internal/tests/api/",
	"./internal/tests/api/sandboxes/",
	"./internal/tests/api/metrics/",
	"./internal/tests/api/volumes/",
	"./internal/tests/envd/",
];
const API_KEY = "e2b_0000000000000000000000000000000000000000";

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
} finally {
	await removeLeftovers().catch((err) => console.error(`cleanup: ${err}`));
	server.kill("SIGTERM");
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
async function removeLeftovers() {
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
