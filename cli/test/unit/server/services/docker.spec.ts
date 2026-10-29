import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
	config: {
		dockerSocket: "/var/run/docker.sock",
		envdPort: 49983,
		defaultTimeoutSec: 300,
		defaultUser: "user",
		envdHealthTimeoutMs: 500,
		envdHealthIntervalMs: 100,
	},
}));

const listContainers = vi.fn();
const inspect = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const remove = vi.fn();
const execCreate = vi.fn();
const execStart = vi.fn();
const execInspect = vi.fn();

vi.mock("dockerode", () => ({
	default: class {
		listContainers = listContainers;
		getContainer() {
			return {
				inspect,
				start,
				stop,
				remove,
				exec: execCreate,
			};
		}
	},
}));

const { DockerService } = await import(
	"../../../../src/server/services/docker.ts"
);

function containerInfo(startedAt: string, running = true) {
	return {
		Id: "container-1",
		Name: "/sbx-test",
		Created: "2026-07-28T00:00:00.000Z",
		Config: {
			Labels: {
				"e2b.sandbox-id": "sbx-test",
				"e2b.access-token": "token-test",
				"e2b.template-id": "base",
				"e2b.created-at": "2026-07-28T00:00:00.000Z",
				"e2b.timeout": "300",
			},
		},
		State: { Running: running, StartedAt: startedAt },
		NetworkSettings: {
			Ports: { "49983/tcp": [{ HostPort: "54321" }] },
		},
	};
}

describe("DockerService timeout anchor", () => {
	let backend: InstanceType<typeof DockerService>;
	let tempDir: string;
	let statePath: string;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "sandbox-docker-"));
		statePath = join(tempDir, "timeouts.json");
		backend = new DockerService({
			socketPath: "/var/run/docker.sock",
			statePath,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses the latest Docker start time when reconciling a running sandbox", async () => {
		listContainers.mockResolvedValue([
			{
				Id: "container-1",
				State: "running",
				Labels: { "e2b.sandbox-id": "sbx-test" },
				Ports: [],
			},
		]);
		inspect.mockResolvedValue(containerInfo("2026-07-28T01:00:00.000Z"));

		const sandboxes = await backend.listSandboxes({ state: "running" });

		expect(sandboxes[0]?.timeoutFrom).toBe("2026-07-28T01:00:00.000Z");
		expect(inspect).toHaveBeenCalledOnce();
	});

	it("persists a refreshed timeout across control-plane restarts", async () => {
		vi.setSystemTime(new Date("2026-07-28T02:00:00.000Z"));
		start.mockResolvedValue(undefined);
		inspect.mockResolvedValue(containerInfo("2026-07-28T01:00:00.000Z"));

		await backend.startContainer("sbx-test");
		backend.refreshTimeout("sbx-test", 900);
		const restarted = new DockerService({
			socketPath: "/var/run/docker.sock",
			statePath,
		});
		const sandbox = await restarted.inspectSandbox("sbx-test");

		expect(sandbox?.timeoutFrom).toBe("2026-07-28T02:00:00.000Z");
		// The creation time does not move with the timeout.
		expect(sandbox?.startedAt).toBe("2026-07-28T00:00:00.000Z");
		expect(sandbox?.timeoutSec).toBe(900);
	});

	it("clears refreshed timeout metadata when Docker reports already stopped", async () => {
		backend.refreshTimeout("sbx-test", 900);
		stop.mockRejectedValue(
			Object.assign(new Error("already stopped"), {
				statusCode: 304,
			}),
		);

		await expect(backend.stopContainer("sbx-test")).resolves.toBe(true);
		// Started again later: a refreshed timeout that was not cleared would
		// show here (a stopped container's saved timeout is ignored anyway).
		inspect.mockResolvedValue(containerInfo("2026-07-28T01:00:00.000Z"));
		const restarted = new DockerService({
			socketPath: "/var/run/docker.sock",
			statePath,
		});
		const sandbox = await restarted.inspectSandbox("sbx-test");

		expect(sandbox?.timeoutFrom).toBe("2026-07-28T01:00:00.000Z");
		expect(sandbox?.timeoutSec).toBe(300);
	});

	it("skips a running container removed between list and inspect", async () => {
		listContainers.mockResolvedValue([
			{
				Id: "container-gone",
				State: "running",
				Labels: { "e2b.sandbox-id": "sbx-gone" },
				Ports: [],
			},
			{
				Id: "container-1",
				State: "running",
				Labels: { "e2b.sandbox-id": "sbx-test" },
				Ports: [],
			},
		]);
		inspect
			.mockRejectedValueOnce(
				Object.assign(new Error("not found"), {
					statusCode: 404,
				}),
			)
			.mockResolvedValueOnce(containerInfo("2026-07-28T01:00:00.000Z"));

		const sandboxes = await backend.listSandboxes({ state: "running" });

		expect(sandboxes.map((sandbox) => sandbox.sandboxId)).toEqual(["sbx-test"]);
	});
});

describe("DockerService.runTemplateStart", () => {
	let backend: InstanceType<typeof DockerService>;
	let tempDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "sandbox-docker-"));
		backend = new DockerService({
			socketPath: "/var/run/docker.sock",
			statePath: join(tempDir, "timeouts.json"),
		});
		inspect.mockResolvedValue({
			Config: {
				Labels: { "e2b.ready-cmd": "sleep 3600" },
			},
		});
		execCreate.mockResolvedValue({
			start: execStart,
			inspect: execInspect,
		});
		execStart.mockImplementation(async () => {
			// A command that never exits: its output stream never ends.
			return Object.assign(new EventEmitter(), { resume() {} });
		});
		execInspect.mockResolvedValue({ ExitCode: 1 });
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("fails when the ready command does not finish before the health deadline", async () => {
		// The expectation attaches before the timers run, so the rejection is
		// never unhandled.
		const failed = expect(backend.runTemplateStart("sbx-test")).rejects.toThrow(
			/did not succeed within 500 ms/,
		);
		await vi.advanceTimersByTimeAsync(600);
		await failed;
	});
});
