import { describe, expect, it } from "vitest";
import {
	compareUpstreamBaseline,
	parseBaseline,
} from "../../../scripts/upstream-conformance.ts";

describe("parseBaseline", () => {
	it("ignores comments and blank lines", () => {
		const baseline = parseBaseline(`# comment
api TestHealth

envd TestStat
`);
		expect(baseline).toEqual(new Set(["api TestHealth", "envd TestStat"]));
	});
});

describe("compareUpstreamBaseline", () => {
	const baseline = new Set([
		"api TestHealth",
		"api/sandboxes TestSandboxFork",
		"envd TestStat",
	]);

	it("reports a regression when a baseline test did not pass", () => {
		const results = new Map<string, string>([
			["api TestHealth", "pass"],
			["api/sandboxes TestSandboxFork", "fail"],
			["envd TestStat", "pass"],
		]);
		const { regressions, improvements } = compareUpstreamBaseline(
			baseline,
			results,
			"",
		);
		expect(regressions).toEqual(["api/sandboxes TestSandboxFork"]);
		expect(improvements).toEqual([]);
	});

	it("reports improvements for passes not in the baseline", () => {
		const results = new Map<string, string>([
			["api TestHealth", "pass"],
			["api/sandboxes TestSandboxFork", "pass"],
			["envd TestStat", "pass"],
			["envd TestWatcher", "pass"],
		]);
		const { regressions, improvements } = compareUpstreamBaseline(
			baseline,
			results,
			"",
		);
		expect(regressions).toEqual([]);
		expect(improvements).toEqual(["envd TestWatcher"]);
	});

	it("with --run filter, only compares baseline tests that ran", () => {
		const results = new Map<string, string>([
			["api/sandboxes TestSandboxFork", "fail"],
		]);
		const { regressions, improvements } = compareUpstreamBaseline(
			baseline,
			results,
			"TestSandboxFork",
		);
		expect(regressions).toEqual(["api/sandboxes TestSandboxFork"]);
		expect(improvements).toEqual([]);
		expect(
			compareUpstreamBaseline(baseline, results, "TestSandboxFork").regressions,
		).not.toContain("api TestHealth");
	});
});
