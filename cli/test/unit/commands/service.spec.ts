import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec, write, unlink, readConfig, exists } = vi.hoisted(() => ({
	exec: vi.fn(),
	write: vi.fn(),
	unlink: vi.fn(),
	readConfig: vi.fn(),
	exists: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFileSync: exec,
	execSync: (command: string) => {
		const [file, ...args] = command.split(" ");
		return exec(file, args);
	},
}));
vi.mock("node:fs", () => ({
	existsSync: exists,
	mkdirSync: vi.fn(),
	writeFileSync: write,
	unlinkSync: unlink,
}));
vi.mock("../../../src/lib/config.ts", () => ({
	readConfig,
	SANDBOX_DIR: "/tmp/example-sandbox",
}));
const { run } = await import("../../../src/commands/service.ts");

describe.skipIf(process.platform !== "darwin")("service command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		exists.mockReturnValue(false);
		exec.mockReset().mockReturnValue("/tmp/example-sandbox/bin/sandbox");
		readConfig.mockReturnValue({ apiKey: "config-key", backend: "docker" });
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("forwards runtime key, port and backend over config defaults, preserving XML", async () => {
		vi.stubEnv("API_KEYS", "env-key&second");
		vi.stubEnv("PORT", "51234");
		vi.stubEnv("SANDBOX_BACKEND", "shuru");
		vi.stubEnv("SANDBOX_MACOS_BACKEND", "");
		await run(["install"]);
		const plist = String(write.mock.calls[0]?.[1]);
		expect(plist).toContain(
			"<key>API_KEYS</key>\n      <string>env-key&amp;second</string>",
		);
		expect(plist).toContain("<key>PORT</key>\n      <string>51234</string>");
		expect(plist).toContain(
			"<key>SANDBOX_BACKEND</key>\n      <string>shuru</string>",
		);
		expect(plist).toContain(
			"<key>SANDBOX_MACOS_BACKEND</key>\n      <string></string>",
		);
		expect(plist).not.toContain("config-key");
	});
	it("keeps the plist when unload fails and the job is still loaded", async () => {
		exists.mockReturnValue(true);
		const failure = new Error("unload denied");
		exec.mockImplementation((_command, args) => {
			if (args[0] === "unload") throw failure;
			return "loaded";
		});
		await expect(run(["uninstall"])).rejects.toThrow("unload denied");
		expect(unlink).not.toHaveBeenCalled();
	});
	it("removes a plist for a job already absent from launchd", async () => {
		exists.mockReturnValue(true);
		exec.mockImplementation((_command, args) => {
			throw Object.assign(new Error("absent"), {
				status: args[0] === "list" ? 113 : 1,
			});
		});
		await run(["uninstall"]);
		expect(unlink).toHaveBeenCalledOnce();
	});
	it("keeps the plist when launchd status cannot be determined", async () => {
		exists.mockReturnValue(true);
		exec.mockImplementation(() => {
			throw Object.assign(new Error("launchd unavailable"), { status: 1 });
		});
		await expect(run(["uninstall"])).rejects.toThrow("launchd unavailable");
		expect(unlink).not.toHaveBeenCalled();
	});
	it("removes the plist after a successful unload", async () => {
		exists.mockReturnValue(true);
		await run(["uninstall"]);
		expect(unlink).toHaveBeenCalledOnce();
	});
});
