import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_LIFECYCLE } from "../../../../src/server/services/lifecycle.ts";

vi.mock("../../../../src/server/config.ts", () => ({
	config: { envdPort: 49983 },
}));

// Mock tart CLI calls. The backend runs them with exec, so they never block
// the server; execSyncMock gives each command's output either way.
const execSyncMock = vi.fn();
/** Commands whose callback is held until released, to observe a pending call. */
const held = new Map<string, () => void>();
const execMock = vi.fn(
	(
		cmd: string,
		opts: unknown,
		cb: (err: Error | null, stdout?: string) => void,
	) => {
		const finish = () => {
			try {
				cb(null, execSyncMock(cmd, opts));
			} catch (err) {
				cb(err as Error);
			}
		};
		const hold = [...held.keys()].find((prefix) => cmd.startsWith(prefix));
		if (hold) held.set(hold, finish);
		else queueMicrotask(finish);
	},
);
vi.mock("node:child_process", () => ({
	execSync: (...args: unknown[]) => execSyncMock(...args),
	exec: (...args: Parameters<typeof execMock>) => execMock(...args),
}));

// Mock net for port allocation and TCP proxy
const mockPort = 54321;
const mockProxyServer = {
	listen: vi.fn(),
	close: vi.fn(),
	on: vi.fn(),
};
const mockConnect = vi.fn();
vi.mock("node:net", () => ({
	createServer: (...args: unknown[]) => {
		// If called with a connection handler, it's the TCP proxy
		if (typeof args[0] === "function") {
			return mockProxyServer;
		}
		// Otherwise it's the port finder
		return {
			listen: (_port: number, cb: () => void) => cb(),
			address: () => ({ port: mockPort }),
			close: (cb: () => void) => cb(),
			on: () => ({}),
		};
	},
	connect: mockConnect,
}));

// Mock Bun.spawn
const mockProc: {
	pid: number;
	exitCode: number | null;
	stderr?: ReadableStream;
} = {
	pid: 12345,
	exitCode: null,
};
const spawnMock = vi.fn().mockReturnValue(mockProc);
globalThis.Bun = { spawn: spawnMock } as unknown as typeof Bun;

const { TartBackend } = await import("../../../../src/server/services/tart.ts");

describe("TartBackend", () => {
	let backend: InstanceType<typeof TartBackend>;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new TartBackend();
	});

	it("has type tart", () => {
		expect(backend.type).toBe("tart");
	});

	it("supports pause", () => {
		expect(backend.supportsPause).toBe(true);
	});

	describe("resolveImage", () => {
		it("returns image name when VM exists", async () => {
			execSyncMock.mockReturnValue(
				JSON.stringify([{ Name: "sandbox-base", State: "stopped" }]),
			);

			const result = await backend.resolveImage("base");
			expect(result).toBe("sandbox-base");
		});

		it("returns prefixed name for non-base template", async () => {
			execSyncMock.mockReturnValue(
				JSON.stringify([{ Name: "sandbox-python", State: "stopped" }]),
			);

			const result = await backend.resolveImage("python");
			expect(result).toBe("sandbox-python");
		});

		it("throws when template VM does not exist", async () => {
			execSyncMock.mockReturnValue(JSON.stringify([]));

			await expect(backend.resolveImage("python")).rejects.toThrow(
				'Template "python" not found',
			);
		});
	});

	describe("createContainer", () => {
		it("clones and runs the VM", async () => {
			// resolveImage call
			execSyncMock
				.mockReturnValueOnce(
					JSON.stringify([{ Name: "sandbox-base", State: "stopped" }]),
				)
				// clone call
				.mockReturnValueOnce("")
				// tart list call (is the clone suspended?)
				.mockReturnValueOnce(
					JSON.stringify([{ Name: "sandbox-sbx-test1", State: "stopped" }]),
				)
				// tart ip call
				.mockReturnValueOnce("192.168.64.5");

			// Mock fetch for health check
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue({ status: 204 }) as unknown as typeof fetch;

			// Speed up the initial boot delay (setTimeout)
			vi.useRealTimers();
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
				originalSetTimeout(fn, 0)) as typeof setTimeout;

			const result = await backend.createContainer({
				sandboxId: "sbx-test1",
				accessToken: "token-abc",
				templateId: "base",
				timeoutSec: 300,
				lifecycle: LEGACY_LIFECYCLE,
			});

			globalThis.setTimeout = originalSetTimeout;
			globalThis.fetch = originalFetch;

			expect(result.instanceId).toBe("sandbox-sbx-test1");
			expect(result.hostPort).toBe(mockPort);

			// Verify tart clone was called
			expect(execSyncMock).toHaveBeenCalledWith(
				"tart clone sandbox-base sandbox-sbx-test1",
				expect.objectContaining({ encoding: "utf-8" }),
			);

			// Verify tart run was spawned with --suspendable
			expect(spawnMock).toHaveBeenCalledWith(
				["tart", "run", "sandbox-sbx-test1", "--no-graphics", "--suspendable"],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);

			// envd goes through the local proxy; other ports to the VM's address
			expect(await backend.resolveTarget("sbx-test1", 49983)).toEqual({
				host: "localhost",
				port: mockPort,
			});
			expect(await backend.resolveTarget("sbx-test1", 3000)).toEqual({
				host: "192.168.64.5",
				port: 3000,
			});
			// A stopped tart VM counts as finished, so only memory-keeping pauses exist
			await expect(
				backend.stopContainer("sbx-test1", { keepMemory: false }),
			).rejects.toThrow(/cannot pause without keeping memory/);
		});
	});

	describe("createContainer when tart cannot start the VM", () => {
		it("reports tart's own error instead of a generic IP timeout", async () => {
			execSyncMock.mockImplementation((cmd: string) => {
				if (cmd.startsWith("tart list")) {
					return JSON.stringify([{ Name: "sandbox-base", State: "stopped" }]);
				}
				if (cmd.startsWith("tart ip")) throw new Error("no IP");
				return "";
			});
			mockProc.exitCode = 1;
			mockProc.stderr =
				new Response(
					"The number of VMs exceeds the system limit (other running VMs: a, b)\n",
				).body ?? undefined;
			vi.useRealTimers();
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((fn: () => void) =>
				originalSetTimeout(fn, 0)) as typeof setTimeout;
			try {
				await expect(
					backend.createContainer({
						sandboxId: "sbx-limit",
						accessToken: "t",
						templateId: "base",
						timeoutSec: 300,
						lifecycle: LEGACY_LIFECYCLE,
					}),
				).rejects.toThrow(
					/did not start: The number of VMs exceeds the system limit/,
				);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				mockProc.exitCode = null;
				mockProc.stderr = undefined;
			}
		});
	});

	describe("stopContainer", () => {
		it("returns false for unknown sandbox", async () => {
			const result = await backend.stopContainer("sbx-unknown");
			expect(result).toBe(false);
		});
	});

	describe("removeContainer", () => {
		it("returns false for unknown sandbox", async () => {
			const result = await backend.removeContainer("sbx-unknown");
			expect(result).toBe(false);
		});
	});

	describe("inspectSandbox", () => {
		it("returns null for unknown sandbox", async () => {
			const result = await backend.inspectSandbox("sbx-unknown");
			expect(result).toBeNull();
		});
	});

	describe("a pause the host cannot save", () => {
		const addInstance = (id: string) =>
			(backend as unknown as { instances: Map<string, unknown> }).instances.set(
				id,
				{
					sandboxId: id,
					vmName: `sandbox-${id}`,
					hostPort: 1,
					accessToken: "t",
					templateId: "base",
					createdAt: new Date().toISOString(),
					timeoutSec: 300,
					lifecycle: LEGACY_LIFECYCLE,
				},
			);

		it("keeps the stopped VM as a paused sandbox instead of deleting it", async () => {
			addInstance("sbx-p");
			execSyncMock.mockImplementation((cmd: string) =>
				cmd.startsWith("tart list")
					? JSON.stringify([{ Name: "sandbox-sbx-p", State: "stopped" }])
					: "",
			);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(await backend.stopContainer("sbx-p")).toBe(true);
			expect(warn).toHaveBeenCalledWith(
				expect.stringMatching(/could not save VM/),
			);

			const [info] = await backend.listSandboxes();
			expect(info?.state).toBe("paused");
			expect(execSyncMock).not.toHaveBeenCalledWith(
				expect.stringMatching(/^tart delete/),
				expect.anything(),
			);
		});

		it("still cleans up a VM that stopped by itself", async () => {
			addInstance("sbx-done");
			execSyncMock.mockImplementation((cmd: string) =>
				cmd.startsWith("tart list")
					? JSON.stringify([{ Name: "sandbox-sbx-done", State: "stopped" }])
					: "",
			);
			vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await backend.listSandboxes()).toHaveLength(0);
			expect(execSyncMock).toHaveBeenCalledWith(
				"tart delete sandbox-sbx-done",
				expect.anything(),
			);
		});
	});

	describe("listSandboxes", () => {
		it("returns empty list when no instances", async () => {
			execSyncMock.mockReturnValue(JSON.stringify([]));
			const list = await backend.listSandboxes();
			expect(list).toHaveLength(0);
		});
	});

	describe("isAvailable", () => {
		it("returns true when the tart CLI runs", () => {
			execSyncMock.mockReturnValue("tart 2.0.0");
			expect(TartBackend.isAvailable()).toBe(true);
		});

		it("returns false when the tart CLI is not installed", () => {
			execSyncMock.mockImplementation(() => {
				throw new Error("/bin/sh: tart: command not found");
			});
			expect(TartBackend.isAvailable()).toBe(false);
		});

		it("probes without leaking output to the console", () => {
			execSyncMock.mockReturnValue("");
			TartBackend.isAvailable();
			expect(execSyncMock).toHaveBeenCalledWith(
				"tart --version",
				expect.objectContaining({ stdio: "ignore" }),
			);
		});
	});

	describe("tart command execution", () => {
		it("captures output with exec instead of leaking it to the parent console", async () => {
			execSyncMock.mockReturnValue(JSON.stringify([]));

			await backend.listSandboxes();

			expect(execMock).toHaveBeenCalledWith(
				"tart list --format json",
				expect.objectContaining({ encoding: "utf-8" }),
				expect.any(Function),
			);
		});

		it("keeps serving other requests while a slow tart command runs", async () => {
			(backend as unknown as { instances: Map<string, unknown> }).instances.set(
				"sbx-s",
				{
					sandboxId: "sbx-s",
					vmName: "sandbox-sbx-s",
					hostPort: 1,
					accessToken: "t",
					templateId: "base",
					createdAt: new Date().toISOString(),
					timeoutSec: 300,
					lifecycle: LEGACY_LIFECYCLE,
				},
			);
			execSyncMock.mockImplementation((cmd: string) =>
				cmd.startsWith("tart list")
					? JSON.stringify([{ Name: "sandbox-sbx-s", State: "suspended" }])
					: "",
			);
			held.set("tart suspend", () => {});

			const pausing = backend.stopContainer("sbx-s");
			await vi.waitFor(() =>
				expect(execMock).toHaveBeenCalledWith(
					"tart suspend sandbox-sbx-s",
					expect.anything(),
					expect.any(Function),
				),
			);
			// The suspend has not returned, yet another request completes.
			const [info] = await backend.listSandboxes();
			expect(info?.sandboxId).toBe("sbx-s");

			held.get("tart suspend")?.();
			held.clear();
			expect(await pausing).toBe(true);
		});
	});

	describe("a list while a VM is being created", () => {
		it("does not delete the clone as orphaned or finished", async () => {
			let ipFails = false;
			execSyncMock.mockImplementation((cmd: string) => {
				if (cmd.startsWith("tart list")) {
					return JSON.stringify([
						{ Name: "sandbox-base", State: "stopped" },
						{ Name: "sandbox-sbx-new", State: "stopped" },
					]);
				}
				if (cmd.startsWith("tart ip") && ipFails) throw new Error("no IP");
				return "";
			});
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.useRealTimers();
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((fn: () => void) =>
				originalSetTimeout(fn, 0)) as typeof setTimeout;
			try {
				// Cloned, not yet registered.
				held.set("tart clone", () => {});
				const creating = backend
					.createContainer({
						sandboxId: "sbx-new",
						accessToken: "t",
						templateId: "base",
						timeoutSec: 300,
						lifecycle: LEGACY_LIFECYCLE,
					})
					.catch(() => {});
				await vi.waitFor(() => expect(held.get("tart clone")).toBeDefined());
				await vi.waitFor(() =>
					expect(execMock).toHaveBeenCalledWith(
						"tart clone sandbox-base sandbox-sbx-new",
						expect.anything(),
						expect.any(Function),
					),
				);
				await backend.listSandboxes();

				// Registered and booting: tart still lists it as stopped.
				held.set("tart ip", () => {});
				held.get("tart clone")?.();
				await vi.waitFor(() =>
					expect(execMock).toHaveBeenCalledWith(
						expect.stringMatching(/^tart ip/),
						expect.anything(),
						expect.any(Function),
					),
				);
				await backend.listSandboxes();

				expect(execSyncMock).not.toHaveBeenCalledWith(
					expect.stringMatching(/^tart (delete|stop) sandbox-sbx-new/),
					expect.anything(),
				);

				// Let the creation finish (it fails without an IP).
				ipFails = true;
				const release = held.get("tart ip");
				held.clear();
				release?.();
				await creating;
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				held.clear();
			}
		});
	});

	describe("resuming when tart cannot start the VM", () => {
		it("tries again, then reports tart's own error", async () => {
			(backend as unknown as { instances: Map<string, unknown> }).instances.set(
				"sbx-r",
				{
					sandboxId: "sbx-r",
					vmName: "sandbox-sbx-r",
					hostPort: 1,
					accessToken: "t",
					templateId: "base",
					createdAt: new Date().toISOString(),
					timeoutSec: 300,
					lifecycle: LEGACY_LIFECYCLE,
					paused: true,
				},
			);
			execSyncMock.mockImplementation((cmd: string) => {
				if (cmd.startsWith("tart list")) {
					return JSON.stringify([{ Name: "sandbox-sbx-r", State: "stopped" }]);
				}
				if (cmd.startsWith("tart ip")) throw new Error("no IP");
				return "";
			});
			mockProc.exitCode = 1;
			spawnMock.mockImplementation(() => ({
				...mockProc,
				stderr: new Response("VM is locked by another process\n").body,
			}));
			vi.useRealTimers();
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((fn: () => void) =>
				originalSetTimeout(fn, 0)) as typeof setTimeout;
			try {
				await expect(backend.startContainer("sbx-r")).rejects.toThrow(
					/did not resume: VM is locked by another process/,
				);
				expect(spawnMock).toHaveBeenCalledTimes(4);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				mockProc.exitCode = null;
				spawnMock.mockReset();
				spawnMock.mockReturnValue(mockProc);
			}
		});
	});
});
