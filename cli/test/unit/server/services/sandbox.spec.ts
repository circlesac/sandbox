import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ContainerBackend,
	CreateContainerOpts,
	ProxyTarget,
} from "../../../../src/server/services/backend.ts";
import type { EnvdService } from "../../../../src/server/services/envd.ts";
import { LEGACY_LIFECYCLE } from "../../../../src/server/services/lifecycle.ts";
import {
	NotFoundError,
	SandboxService,
	UnsupportedError,
} from "../../../../src/server/services/sandbox.ts";
import { TtlService } from "../../../../src/server/services/ttl.ts";
import type { SandboxInfo } from "../../../../src/server/types.ts";

vi.mock("../../../../src/server/config.ts", () => ({
	config: {
		defaultTimeoutSec: 300,
		maxTimeoutSec: 3600,
		envdVersion: "0.5.3",
		defaultUser: "user",
		envdPort: 49983,
	},
}));

type State = "running" | "frozen" | "stopped";

interface FakeSandbox {
	opts: CreateContainerOpts;
	state: State;
	/** Timeout anchor, like Docker's persisted start time. */
	startedAt: number;
	timeoutSec: number;
}

/**
 * An in-memory backend that keeps the state a real one does: containers,
 * their pause mode, and a persisted timeout anchor. It lets the tests drive
 * the real SandboxService and TtlService through time.
 */
class FakeBackend implements ContainerBackend {
	readonly type = "docker" as const;
	supportsPause = true;
	supportsFilesystemPause = true;
	envdChecksAccessToken = true;
	sandboxes = new Map<string, FakeSandbox>();
	events: string[] = [];

	async resolveImage() {
		return "sandbox-base:latest";
	}

	async createContainer(opts: CreateContainerOpts) {
		this.sandboxes.set(opts.sandboxId, {
			opts,
			state: "running",
			startedAt: Date.now(),
			timeoutSec: opts.timeoutSec,
		});
		this.events.push(`create ${opts.sandboxId}`);
		return { instanceId: opts.sandboxId, hostPort: 40000 };
	}

	async startContainer(sandboxId: string) {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) throw new Error("gone");
		if (sb.state === "stopped") sb.startedAt = Date.now();
		sb.state = "running";
		this.events.push(`start ${sandboxId}`);
		return { hostPort: 40001 };
	}

	refreshTimeout(sandboxId: string, timeoutSec: number) {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) return;
		sb.startedAt = Date.now();
		sb.timeoutSec = timeoutSec;
	}

	async stopContainer(sandboxId: string, opts: { keepMemory?: boolean } = {}) {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) return false;
		sb.state = opts.keepMemory ? "frozen" : "stopped";
		this.events.push(`${sb.state} ${sandboxId}`);
		return true;
	}

	async removeContainer(sandboxId: string) {
		this.events.push(`remove ${sandboxId}`);
		return this.sandboxes.delete(sandboxId);
	}

	async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) return null;
		return {
			sandboxId,
			instanceId: sandboxId,
			accessToken: sb.opts.accessToken,
			templateId: sb.opts.templateId,
			createdAt: new Date(sb.startedAt).toISOString(),
			timeoutSec: sb.timeoutSec,
			hostPort: 40000,
			state: sb.state === "running" ? "running" : "paused",
			metadata: sb.opts.metadata,
			lifecycle: sb.opts.lifecycle,
		};
	}

	async listSandboxes(filters?: { state?: "running" | "paused" }) {
		const all = await Promise.all(
			[...this.sandboxes.keys()].map((id) => this.inspectSandbox(id)),
		);
		return all.filter(
			(s): s is SandboxInfo =>
				s !== null && (!filters?.state || s.state === filters.state),
		);
	}

	async resolveTarget(): Promise<ProxyTarget | null> {
		return { host: "localhost", port: 40000 };
	}

	stateOf(sandboxId: string): State | "removed" {
		return this.sandboxes.get(sandboxId)?.state ?? "removed";
	}
}

function fakeEnvd() {
	return {
		waitForHealth: vi.fn().mockResolvedValue(undefined),
		init: vi.fn().mockResolvedValue(undefined),
	};
}

describe("SandboxService", () => {
	let backend: FakeBackend;
	let envd: ReturnType<typeof fakeEnvd>;
	let ttl: TtlService;
	let service: SandboxService;

	const newService = () =>
		new SandboxService({ linux: backend }, envd as unknown as EnvdService, ttl);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
		backend = new FakeBackend();
		envd = fakeEnvd();
		ttl = new TtlService();
		service = newService();
	});

	afterEach(() => {
		ttl.clearAll();
		vi.useRealTimers();
	});

	describe("create", () => {
		it("creates a container, waits for envd, initializes it with the token, and responds", async () => {
			const result = await service.create(
				{ templateID: "base" },
				{ domain: "localhost:49982" },
			);

			expect(result.sandboxID).toMatch(/^sbx-/);
			expect(result.envdAccessToken).toBeTruthy();
			expect(result.trafficAccessToken).toBeNull();
			expect(result.domain).toBe("localhost:49982");
			expect(envd.waitForHealth).toHaveBeenCalledWith(40000);
			expect(envd.init).toHaveBeenCalledWith(40000, {
				accessToken: result.envdAccessToken,
				envVars: undefined,
			});
		});

		it("removes the container when envd never becomes healthy", async () => {
			envd.waitForHealth.mockRejectedValue(new Error("timeout"));
			await expect(service.create({ templateID: "base" })).rejects.toThrow(
				"timeout",
			);
			expect(backend.sandboxes.size).toBe(0);
		});

		it("clamps the timeout to maxTimeoutSec", async () => {
			const { sandboxID } = await service.create({ timeout: 99999 });
			expect(backend.sandboxes.get(sandboxID)?.timeoutSec).toBe(3600);
		});

		it("records the lifecycle the request asked for", async () => {
			const { sandboxID } = await service.create({
				autoPause: true,
				autoResume: { enabled: true },
			});
			expect(backend.sandboxes.get(sandboxID)?.opts.lifecycle).toMatchObject({
				autoPause: true,
				keepMemory: true,
				autoResume: true,
				secure: true,
			});
		});

		it("does not give envd a token, or the client one, when secure is false", async () => {
			const result = await service.create({ secure: false });
			expect(result.envdAccessToken).toBeNull();
			expect(envd.init).toHaveBeenCalledWith(40000, {
				accessToken: undefined,
				envVars: undefined,
			});
		});

		it("rejects an option it cannot honor before creating anything", async () => {
			await expect(
				service.create({ volumeMounts: [{ name: "v", path: "/data" }] }),
			).rejects.toBeInstanceOf(UnsupportedError);
			expect(backend.sandboxes.size).toBe(0);
		});
	});

	describe("timeout", () => {
		it("kills by default, exactly at the deadline and not before", async () => {
			const { sandboxID } = await service.create({ timeout: 10 });

			await vi.advanceTimersByTimeAsync(9_999);
			expect(backend.stateOf(sandboxID)).toBe("running");

			await vi.advanceTimersByTimeAsync(1);
			expect(backend.stateOf(sandboxID)).toBe("removed");
		});

		it("pauses and keeps memory when autoPause is set", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
		});

		it("pauses to the filesystem only when autoPauseMemory is false", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
				autoPauseMemory: false,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(backend.stateOf(sandboxID)).toBe("stopped");
		});

		it("kills on timeout when the backend cannot pause, and rejects autoPause there", async () => {
			backend.supportsPause = false;
			await expect(service.create({ autoPause: true })).rejects.toBeInstanceOf(
				UnsupportedError,
			);
			const { sandboxID } = await service.create({ timeout: 10 });
			await vi.advanceTimersByTimeAsync(10_000);
			expect(backend.stateOf(sandboxID)).toBe("removed");
		});

		it("follows a shortened timeout from setTimeout", async () => {
			const { sandboxID } = await service.create({ timeout: 300 });
			await service.setTimeout(sandboxID, 5);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(backend.stateOf(sandboxID)).toBe("removed");
		});

		it("does nothing more once a sandbox is gone or paused", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			const events = backend.events.length;

			await service.expire(sandboxID);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(backend.events.length).toBe(events);
		});
	});

	describe("restart", () => {
		it("re-arms running sandboxes from the persisted anchor and expires overdue ones", async () => {
			const fresh = await service.create({ timeout: 100 });
			const overdue = await service.create({ timeout: 100, autoPause: true });
			backend.sandboxes.get(overdue.sandboxID)!.startedAt -= 200_000;
			ttl.clearAll();

			// A new process with no timers and no memory of the sandboxes.
			ttl = new TtlService();
			service = newService();
			expect(await service.reconcile()).toBe(2);

			expect(backend.stateOf(overdue.sandboxID)).toBe("frozen");
			await vi.advanceTimersByTimeAsync(99_999);
			expect(backend.stateOf(fresh.sandboxID)).toBe("running");
			await vi.advanceTimersByTimeAsync(1);
			expect(backend.stateOf(fresh.sandboxID)).toBe("removed");
		});

		it("reconciling again does not touch paused sandboxes or loop", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			const events = backend.events.length;

			expect(await service.reconcile()).toBe(0);
			expect(await service.reconcile()).toBe(0);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
			expect(backend.events.length).toBe(events);
		});

		it("keeps the old pause-on-timeout behavior for sandboxes created before lifecycles", async () => {
			const { sandboxID } = await service.create({ timeout: 10 });
			backend.sandboxes.get(sandboxID)!.opts.lifecycle = LEGACY_LIFECYCLE;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(backend.stateOf(sandboxID)).toBe("stopped");
		});
	});

	describe("pause", () => {
		it("keeps memory by default and stops the timeout", async () => {
			const { sandboxID } = await service.create({ timeout: 10 });
			expect(await service.pause(sandboxID)).toBe(true);
			expect(backend.stateOf(sandboxID)).toBe("frozen");

			await vi.advanceTimersByTimeAsync(60_000);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
		});

		it("keeps only the filesystem when asked", async () => {
			const { sandboxID } = await service.create({});
			await service.pause(sandboxID, false);
			expect(backend.stateOf(sandboxID)).toBe("stopped");
		});

		it("rejects a filesystem-only pause on a backend that cannot do one", async () => {
			backend.supportsFilesystemPause = false;
			const { sandboxID } = await service.create({});
			await expect(service.pause(sandboxID, false)).rejects.toBeInstanceOf(
				UnsupportedError,
			);
			expect(backend.stateOf(sandboxID)).toBe("running");
		});

		it("returns false for an unknown sandbox", async () => {
			expect(await service.pause("sbx-missing")).toBe(false);
		});
	});

	describe("connect", () => {
		it("resumes a paused sandbox, re-initializes envd, and starts a new timeout", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			envd.init.mockClear();

			await service.connect(sandboxID, 20);
			expect(backend.stateOf(sandboxID)).toBe("running");
			expect(envd.init).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(19_999);
			expect(backend.stateOf(sandboxID)).toBe("running");
			await vi.advanceTimersByTimeAsync(1);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
		});

		it("never shortens a running sandbox's remaining time", async () => {
			const { sandboxID } = await service.create({ timeout: 600 });
			await service.connect(sandboxID, 10);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(backend.stateOf(sandboxID)).toBe("running");
			await vi.advanceTimersByTimeAsync(590_000);
			expect(backend.stateOf(sandboxID)).toBe("removed");
		});

		it("throws NotFoundError for a killed sandbox and does not recreate it", async () => {
			const { sandboxID } = await service.create({});
			await service.kill(sandboxID);
			await expect(service.connect(sandboxID)).rejects.toBeInstanceOf(
				NotFoundError,
			);
			expect(backend.sandboxes.size).toBe(0);
		});
	});

	describe("resumeForTraffic", () => {
		it("resumes a paused sandbox whose lifecycle allows it, once for concurrent requests", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
				autoResume: { enabled: true },
			});
			await vi.advanceTimersByTimeAsync(10_000);
			backend.events.length = 0;

			const results = await Promise.all([
				service.resumeForTraffic(sandboxID),
				service.resumeForTraffic(sandboxID),
				service.resumeForTraffic(sandboxID),
			]);
			expect(results).toEqual([true, true, true]);
			expect(backend.events).toEqual([`start ${sandboxID}`]);
		});

		it("leaves a paused sandbox paused when autoResume is off", async () => {
			const { sandboxID } = await service.create({
				timeout: 10,
				autoPause: true,
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await service.resumeForTraffic(sandboxID)).toBe(false);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
		});

		it("never brings back a sandbox that timed out and was killed", async () => {
			const { sandboxID } = await service.create({ timeout: 10 });
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await service.resumeForTraffic(sandboxID)).toBe(false);
			expect(backend.sandboxes.size).toBe(0);
		});
	});

	describe("list and getInfo", () => {
		it("report each sandbox's state", async () => {
			const running = await service.create({});
			const paused = await service.create({});
			await service.pause(paused.sandboxID);

			const states = Object.fromEntries(
				(await service.list()).map((s) => [s.sandboxID, s.state]),
			);
			expect(states).toEqual({
				[running.sandboxID]: "running",
				[paused.sandboxID]: "paused",
			});
			expect((await service.getInfo(paused.sandboxID))?.state).toBe("paused");
			expect(await service.getInfo("sbx-missing")).toBeNull();
		});
	});
});
