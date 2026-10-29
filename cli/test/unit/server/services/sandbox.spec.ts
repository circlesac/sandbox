import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ContainerBackend,
	CreateContainerOpts,
	ProxyTarget,
} from "../../../../src/server/services/backend.ts";
import type { EnvdService } from "../../../../src/server/services/envd.ts";
import { LEGACY_LIFECYCLE } from "../../../../src/server/services/lifecycle.ts";
import { ConflictError } from "../../../../src/server/errors.ts";
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
	/** Creation time, fixed. */
	createdAt: number;
	/** Timeout anchor, like Docker's persisted start time. */
	timeoutFrom: number;
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
	envdAcceptsAccessToken = true;
	envdVersionValue: string | null = null;
	sandboxes = new Map<string, FakeSandbox>();
	events: string[] = [];
	commits: { templateId: string; labels: Record<string, string> }[] = [];

	async resolveImage() {
		return "sandbox-base:latest";
	}

	async createContainer(opts: CreateContainerOpts) {
		this.sandboxes.set(opts.sandboxId, {
			opts,
			state: "running",
			createdAt: Date.now(),
			timeoutFrom: Date.now(),
			timeoutSec: opts.timeoutSec,
		});
		this.events.push(`create ${opts.sandboxId}`);
		return { instanceId: opts.sandboxId, hostPort: 40000 };
	}

	/** While set, a start waits for it, like a slow resume. */
	startGate: Promise<void> | null = null;

	async startContainer(sandboxId: string) {
		if (this.startGate) await this.startGate;
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) throw new Error("gone");
		if (sb.state === "stopped") sb.timeoutFrom = Date.now();
		sb.state = "running";
		this.events.push(`start ${sandboxId}`);
		return { hostPort: 40001 };
	}

	async commitTemplate(
		sandboxId: string,
		templateId: string,
		labels: Record<string, string>,
	) {
		this.events.push(`commit ${sandboxId} ${templateId}`);
		this.commits.push({ templateId, labels });
	}

	refreshTimeout(sandboxId: string, timeoutSec: number) {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) return;
		sb.timeoutFrom = Date.now();
		sb.timeoutSec = timeoutSec;
	}

	/** While set, a pause waits for it, like a slow docker stop. */
	stopGate: Promise<void> | null = null;

	async stopContainer(sandboxId: string, opts: { keepMemory?: boolean } = {}) {
		if (this.stopGate) await this.stopGate;
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

	/** How many times a sandbox was looked up, as Docker inspects would be. */
	inspections = 0;

	async inspectSandbox(sandboxId: string): Promise<SandboxInfo | null> {
		this.inspections++;
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) return null;
		return {
			sandboxId,
			instanceId: sandboxId,
			accessToken: sb.opts.accessToken,
			templateId: sb.opts.templateId,
			startedAt: new Date(sb.createdAt).toISOString(),
			timeoutFrom: new Date(sb.timeoutFrom).toISOString(),
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

	async envdVersion(): Promise<string | null> {
		return this.envdVersionValue;
	}

	get(sandboxId: string): FakeSandbox {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) throw new Error(`no sandbox ${sandboxId}`);
		return sb;
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
				envVars: {},
			});
		});

		it("removes the container when envd never becomes healthy", async () => {
			envd.waitForHealth.mockRejectedValue(new Error("timeout"));
			await expect(service.create({ templateID: "base" })).rejects.toThrow(
				"timeout",
			);
			expect(backend.sandboxes.size).toBe(0);
		});

		it("rejects a timeout beyond maxTimeoutSec, as E2B does", async () => {
			await expect(service.create({ timeout: 99999 })).rejects.toThrow(
				/timeout must be at most 3600 seconds/,
			);
			expect(backend.sandboxes.size).toBe(0);
		});

		it("rejects a timeout of 0, as E2B does", async () => {
			await expect(service.create({ timeout: 0 })).rejects.toThrow(
				/greater than 0/,
			);
			expect(backend.sandboxes.size).toBe(0);
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

		it("ignores secure: false and secures the sandbox anyway, as E2B does", async () => {
			const result = await service.create({ secure: false });
			expect(result.envdAccessToken).toBeTruthy();
			expect(envd.init).toHaveBeenLastCalledWith(40000, {
				accessToken: result.envdAccessToken,
				envVars: {},
			});
		});

		it("reports the envd version the backend found, or the default", async () => {
			expect((await service.create({})).envdVersion).toBe("0.5.3");
			backend.envdVersionValue = "0.10.2";
			const { sandboxID, envdVersion } = await service.create({});
			expect(envdVersion).toBe("0.10.2");
			expect((await service.getInfo(sandboxID))?.envdVersion).toBe("0.10.2");
		});

		it("gives the token to an envd that accepts one, and withholds it from one that cannot", async () => {
			backend.envdChecksAccessToken = false;
			const accepted = await service.create({});
			expect(envd.init).toHaveBeenLastCalledWith(40000, {
				accessToken: accepted.envdAccessToken,
				envVars: {},
			});

			backend.envdAcceptsAccessToken = false;
			const withheld = await service.create({});
			expect(withheld.envdAccessToken).toBeTruthy();
			expect(envd.init).toHaveBeenLastCalledWith(40000, {
				accessToken: undefined,
				envVars: {},
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
			backend.get(overdue.sandboxID).timeoutFrom -= 200_000;
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

		it("leaves a sandbox that is still booting alone, and times it from when it is ready", async () => {
			let ready = () => {};
			envd.waitForHealth.mockImplementationOnce(
				() =>
					new Promise<void>((r) => {
						ready = r;
					}),
			);
			const creating = service.create({ timeout: 10 });
			await vi.advanceTimersByTimeAsync(0);
			const [booting] = [...backend.sandboxes.keys()];

			// A reconcile during the boot arms nothing for it.
			expect(await service.reconcile()).toBe(0);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(backend.stateOf(booting ?? "")).toBe("running");

			ready();
			await creating;
			await vi.advanceTimersByTimeAsync(9_999);
			expect(backend.stateOf(booting ?? "")).toBe("running");
			await vi.advanceTimersByTimeAsync(1);
			expect(backend.stateOf(booting ?? "")).toBe("removed");
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
			backend.get(sandboxID).opts.lifecycle = LEGACY_LIFECYCLE;
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

	describe("pause conflicts", () => {
		it("shares concurrent pauses, then rejects pausing a paused sandbox", async () => {
			const { sandboxID } = await service.create({});
			const results = await Promise.all([
				service.pause(sandboxID),
				service.pause(sandboxID),
				service.pause(sandboxID),
			]);
			expect(results).toEqual([true, true, true]);
			expect(backend.events.filter((e) => e.startsWith("frozen"))).toHaveLength(
				1,
			);
			await expect(service.pause(sandboxID)).rejects.toBeInstanceOf(
				ConflictError,
			);
		});

		it("lets a connect during a pause resume the sandbox after the pause", async () => {
			const { sandboxID } = await service.create({});
			let release = () => {};
			backend.stopGate = new Promise((r) => {
				release = r;
			});

			const pausing = service.pause(sandboxID);
			const connecting = service.connect(sandboxID, 60);
			await vi.advanceTimersByTimeAsync(0);
			release();
			backend.stopGate = null;
			await Promise.all([pausing, connecting]);

			expect(backend.stateOf(sandboxID)).toBe("running");
			expect(backend.events.slice(-2)).toEqual([
				`frozen ${sandboxID}`,
				`start ${sandboxID}`,
			]);
		});

		it("lets a pause during a resume freeze the sandbox after the resume", async () => {
			const { sandboxID } = await service.create({});
			await service.pause(sandboxID);
			let release = () => {};
			backend.startGate = new Promise((r) => {
				release = r;
			});

			const connecting = service.connect(sandboxID, 60);
			await vi.advanceTimersByTimeAsync(0);
			const pausing = service.pause(sandboxID);
			release();
			backend.startGate = null;
			await Promise.all([connecting, pausing]);

			expect(backend.stateOf(sandboxID)).toBe("frozen");
			expect(backend.events.slice(-2)).toEqual([
				`start ${sandboxID}`,
				`frozen ${sandboxID}`,
			]);
		});

		it("rejects changing the timeout of a paused sandbox", async () => {
			const { sandboxID } = await service.create({});
			await service.pause(sandboxID);
			await expect(service.setTimeout(sandboxID, 60)).rejects.toBeInstanceOf(
				ConflictError,
			);
		});
	});

	describe("refresh", () => {
		it("extends to the requested duration but never shortens", async () => {
			const { sandboxID } = await service.create({ timeout: 60 });
			await service.refresh(sandboxID, 30);
			expect(backend.get(sandboxID).timeoutSec).toBe(60);
			await service.refresh(sandboxID, 120);
			expect(backend.get(sandboxID).timeoutSec).toBe(120);
			await vi.advanceTimersByTimeAsync(119_999);
			expect(backend.stateOf(sandboxID)).toBe("running");
			await vi.advanceTimersByTimeAsync(1);
			expect(backend.stateOf(sandboxID)).toBe("removed");
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

		it("leaves a running sandbox's end time exactly as it was for a shorter request", async () => {
			const { sandboxID } = await service.create({ timeout: 100 });
			const before = (await service.getInfo(sandboxID))?.endAt;
			await vi.advanceTimersByTimeAsync(1_234);
			await service.connect(sandboxID, 10);
			expect((await service.getInfo(sandboxID))?.endAt).toBe(before);
		});

		it("rejects a connect timeout beyond the maximum", async () => {
			const { sandboxID } = await service.create({});
			await expect(service.connect(sandboxID, 99999)).rejects.toThrow(
				/at most/,
			);
		});

		it("rejects a connect timeout of 0, while setTimeout accepts 0", async () => {
			const { sandboxID } = await service.create({});
			await expect(service.connect(sandboxID, 0)).rejects.toThrow(
				/greater than 0/,
			);
			await expect(service.setTimeout(sandboxID, -1)).rejects.toThrow(
				/negative/,
			);
			await service.setTimeout(sandboxID, 0);
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

	describe("IDs with an E2B client-ID suffix", () => {
		it("resolve to the sandbox for every operation", async () => {
			const { sandboxID } = await service.create({ timeout: 60 });
			const suffixed = `${sandboxID}-6532622b`;

			expect((await service.getInfo(suffixed))?.sandboxID).toBe(sandboxID);
			await service.pause(suffixed);
			expect(backend.stateOf(sandboxID)).toBe("frozen");
			await service.connect(suffixed);
			expect(backend.stateOf(sandboxID)).toBe("running");
			expect(await service.kill(suffixed)).toBe(true);
			expect(backend.stateOf(sandboxID)).toBe("removed");
		});

		it("do not match a different sandbox", async () => {
			await service.create({});
			expect(await service.getInfo("sbx-unknown-6532622b")).toBeNull();
		});
	});

	describe("list order", () => {
		it("puts the newest sandbox first, as E2B does", async () => {
			const first = await service.create({});
			await vi.advanceTimersByTimeAsync(1_000);
			const second = await service.create({});
			expect((await service.list()).map((s) => s.sandboxID)).toEqual([
				second.sandboxID,
				first.sandboxID,
			]);
		});
	});

	describe("list filters", () => {
		it("treat startedAfter as inclusive and match the template", async () => {
			const old = await service.create({ templateID: "base" });
			await vi.advanceTimersByTimeAsync(1_000);
			const { sandboxID } = await service.create({ templateID: "app" });
			const startedAt = new Date(Date.now()).toISOString();
			const ids = async (filters: Parameters<SandboxService["list"]>[0]) =>
				(await service.list(filters)).map((s) => s.sandboxID);

			expect(await ids({ startedAfter: startedAt })).toEqual([sandboxID]);
			expect(
				await ids({ startedAfter: new Date(Date.now() + 1_000).toISOString() }),
			).toEqual([]);
			expect(await ids({ template: "base" })).toEqual([old.sandboxID]);
		});
	});

	describe("lookups", () => {
		it("inspect a sandbox once per call", async () => {
			const { sandboxID } = await service.create({});
			const count = async (call: () => Promise<unknown>) => {
				backend.inspections = 0;
				await call();
				return backend.inspections;
			};
			expect(await count(() => service.getInfo(sandboxID))).toBe(1);
			expect(await count(() => service.setTimeout(sandboxID, 60))).toBe(1);
			expect(await count(() => service.connect(sandboxID, 60))).toBe(1);
			// An ID with a client-ID suffix needs a second lookup, once.
			expect(await count(() => service.getInfo(`${sandboxID}-6532622b`))).toBe(
				2,
			);
		});
	});

	describe("startedAt", () => {
		it("stays the creation time when the timeout is extended", async () => {
			const first = await service.create({});
			await vi.advanceTimersByTimeAsync(5_000);
			const second = await service.create({});
			const createdFirst = (await service.getInfo(first.sandboxID))?.startedAt;
			await vi.advanceTimersByTimeAsync(5_000);
			await service.setTimeout(first.sandboxID, 600);
			const ids = async (filters: Parameters<SandboxService["list"]>[0]) =>
				(await service.list(filters)).map((s) => s.sandboxID);

			const info = await service.getInfo(first.sandboxID);
			expect(info?.startedAt).toBe(createdFirst);
			// The end time does move with the extension.
			expect(Date.parse(info?.endAt ?? "")).toBe(Date.now() + 600_000);
			expect(await ids({})).toEqual([second.sandboxID, first.sandboxID]);
			expect(
				await ids({ startedAfter: new Date(Date.now() - 1_000).toISOString() }),
			).toEqual([]);
		});
	});

	describe("template references", () => {
		it("report a tagged template by its name, as E2B does, and filter by it", async () => {
			const { sandboxID, templateID } = await service.create({
				templateID: "app:v1",
			});
			expect(templateID).toBe("app");
			expect((await service.getInfo(sandboxID))?.templateID).toBe("app");
			expect(
				(await service.list({ template: "app" })).map((s) => s.sandboxID),
			).toEqual([sandboxID]);
			// The tag still picks the image.
			expect(backend.get(sandboxID).opts.templateId).toBe("app:v1");
		});
	});

	describe("snapshot", () => {
		it("names a snapshot <name>:<tag>, and an unnamed one has no names", async () => {
			const { sandboxID } = await service.create({});

			const unnamed = await service.snapshot(sandboxID, {});
			expect(unnamed.snapshotID).toMatch(/^snapshot-[a-z0-9]+:default$/);
			expect(unnamed.names).toEqual([]);
			expect(await service.snapshot(sandboxID, { name: "app" })).toEqual({
				snapshotID: "app:default",
				names: ["app"],
			});
			expect(await service.snapshot(sandboxID, { name: "app:v2" })).toEqual({
				snapshotID: "app:v2",
				names: ["app"],
			});
			// Every label is set, so a snapshot of a sandbox started from a named
			// snapshot does not inherit its name.
			expect(backend.commits.map((c) => c.labels["e2b.snapshot-name"])).toEqual(
				["", "app", "app"],
			);
		});

		it("rejects a memory snapshot and a name Docker cannot use", async () => {
			const { sandboxID } = await service.create({});
			await expect(
				service.snapshot(sandboxID, { memory: true }),
			).rejects.toBeInstanceOf(UnsupportedError);
			await expect(
				service.snapshot(sandboxID, { name: "My App" }),
			).rejects.toBeInstanceOf(UnsupportedError);
			expect(backend.commits).toEqual([]);
		});
	});

	describe("fork", () => {
		it("starts forks from the saved filesystem, reporting the source template, for 15 s", async () => {
			const { sandboxID } = await service.create({ templateID: "app" });
			const [result] = await service.fork(sandboxID, {});
			const fork = result?.sandbox;
			expect(fork?.sandboxID).not.toBe(sandboxID);

			const { opts } = backend.get(fork?.sandboxID ?? "");
			expect(opts.templateId).toBe("app");
			expect(opts.imageTemplateId).toBe(backend.commits[0]?.templateId);
			expect(opts.imageTemplateId).toMatch(/^fork-/);
			expect(opts.timeoutSec).toBe(15);
		});

		it("rejects forking a paused sandbox, or with a timeout of 0, before saving anything", async () => {
			const { sandboxID } = await service.create({});
			await expect(service.fork(sandboxID, { timeout: 0 })).rejects.toThrow(
				/greater than 0/,
			);
			await service.pause(sandboxID);
			await expect(service.fork(sandboxID, {})).rejects.toBeInstanceOf(
				ConflictError,
			);
			expect(backend.commits).toEqual([]);
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
			expect((await service.getInfo(running.sandboxID))?.envdAccessToken).toBe(
				running.envdAccessToken,
			);
			expect(await service.getInfo("sbx-missing")).toBeNull();
		});
	});
});
