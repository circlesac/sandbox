import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("npm binary wrapper", () => {
	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "sandbox-wrapper-"));
		dirs.push(dir);
		writeFileSync(join(dir, "package.json"), '{"type":"module"}');
		copyFileSync(
			new URL("../../../bin/sandbox", import.meta.url),
			join(dir, "sandbox"),
		);
		return dir;
	}
	it("runs an installed binary with arguments", () => {
		const dir = fixture();
		mkdirSync(join(dir, "native"));
		writeFileSync(
			join(dir, "native/sandbox"),
			'#!/bin/sh\nprintf "%s\\n" "$@"\n',
		);
		chmodSync(join(dir, "native/sandbox"), 0o755);
		const run = spawnSync(
			process.execPath,
			[join(dir, "sandbox"), "status", "two words"],
			{ encoding: "utf-8" },
		);
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("status\ntwo words\n");
	});
	it("awaits an ES module installer before starting the missing binary", () => {
		const dir = fixture();
		writeFileSync(
			join(dir, "install.js"),
			`
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
await new Promise(r => setTimeout(r, 20));
const native = new URL("./native/", import.meta.url);
mkdirSync(native);
const bin = new URL("sandbox", native);
writeFileSync(bin, '#!/bin/sh\\nprintf "%s\\\\n" "$@"\\n');
chmodSync(bin, 0o755);
`,
		);
		const run = spawnSync(process.execPath, [join(dir, "sandbox"), "--help"], {
			encoding: "utf-8",
		});
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("--help\n");
	});
});
