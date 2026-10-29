import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_LIFECYCLE } from "../../../../src/server/services/lifecycle.ts";

vi.mock("../../../../src/server/config.ts", () => ({
	config: { envdPort: 49983, defaultTimeoutSec: 300 },
}));

/** One container with Docker's state flags, driven by the calls the backend makes. */
const container = {
	running: true,
	paused: false,
	labels: {} as Record<string, string>,
	imageId: "sha256:base",
	imageName: "sandbox-base:latest",
	ip: "172.17.0.5",
	calls: [] as string[],
};

function inspectInfo() {
	return {
		Id: "c1",
		Name: "/sbx-a",
		Created: "2026-10-28T00:00:00.000Z",
		Image: container.imageId,
		Config: { Labels: container.labels, Image: container.imageName },
		State: {
			Running: container.running,
			Paused: container.paused,
			StartedAt: "2026-10-28T00:00:00.000Z",
		},
		NetworkSettings: {
			Ports: { "49983/tcp": [{ HostPort: "54321" }] },
			Networks: { bridge: { IPAddress: container.ip } },
		},
	};
}

let removeError: Error | null = null;
let imageRemoveError: Error | null = null;
const removedImages: string[] = [];

vi.mock("dockerode", () => ({
	default: class {
		getContainer() {
			return {
				inspect: async () => inspectInfo(),
				pause: async () => {
					container.calls.push("pause");
					container.paused = true;
				},
				unpause: async () => {
					container.calls.push("unpause");
					container.paused = false;
				},
				stop: async () => {
					container.calls.push("stop");
					container.running = false;
				},
				start: async () => {
					container.calls.push("start");
					container.running = true;
				},
				remove: async () => {
					if (removeError) throw removeError;
				},
			};
		}
		getImage(id: string) {
			return {
				remove: async () => {
					if (imageRemoveError) throw imageRemoveError;
					removedImages.push(id);
				},
			};
		}
	},
}));

const { DockerService } = await import(
	"../../../../src/server/services/docker.ts"
);

const backend = () =>
	new DockerService({ socketPath: "/var/run/docker.sock", statePath: null });

describe("DockerService pause and resume", () => {
	beforeEach(() => {
		container.running = true;
		container.paused = false;
		container.calls = [];
		container.labels = {
			"e2b.sandbox-id": "sbx-a",
			"e2b.access-token": "tok",
			"e2b.lifecycle": JSON.stringify({
				autoPause: true,
				keepMemory: true,
				autoResume: true,
				secure: true,
				trafficAccessToken: null,
			}),
		};
	});

	it("freezes the container when the pause keeps memory, and reports it paused", async () => {
		const docker = backend();
		await docker.stopContainer("sbx-a", { keepMemory: true });
		expect(container.calls).toEqual(["pause"]);
		expect((await docker.inspectSandbox("sbx-a"))?.state).toBe("paused");
	});

	it("stops the container for a filesystem-only pause", async () => {
		await backend().stopContainer("sbx-a", { keepMemory: false });
		expect(container.calls).toEqual(["stop"]);
	});

	it("unpauses a frozen container and starts a stopped one", async () => {
		const docker = backend();
		container.paused = true;
		await docker.startContainer("sbx-a");
		expect(container.calls).toEqual(["unpause"]);

		container.calls = [];
		container.running = false;
		await docker.startContainer("sbx-a");
		expect(container.calls).toEqual(["start"]);
	});

	it("reads the lifecycle from the label, and the legacy one when it is missing", async () => {
		const docker = backend();
		expect((await docker.inspectSandbox("sbx-a"))?.lifecycle.autoResume).toBe(
			true,
		);
		delete container.labels["e2b.lifecycle"];
		expect((await docker.inspectSandbox("sbx-a"))?.lifecycle).toEqual(
			LEGACY_LIFECYCLE,
		);
	});
});

describe("DockerService.resolveTarget", () => {
	beforeEach(() => {
		container.running = true;
		container.paused = false;
		container.labels = { "e2b.sandbox-id": "sbx-a" };
	});

	it("reaches envd through its published host port", async () => {
		expect(await backend().resolveTarget("sbx-a", 49983)).toEqual({
			host: "localhost",
			port: 54321,
		});
	});

	it("reaches any other port on the container's address", async () => {
		expect(await backend().resolveTarget("sbx-a", 3000)).toEqual({
			host: "172.17.0.5",
			port: 3000,
		});
	});

	it("has no target while the container is paused or stopped", async () => {
		container.paused = true;
		expect(await backend().resolveTarget("sbx-a", 3000)).toBeNull();
		container.paused = false;
		container.running = false;
		expect(await backend().resolveTarget("sbx-a", 49983)).toBeNull();
	});
});

describe("DockerService.removeContainer", () => {
	it("treats a remove already under way as gone, not as an error", async () => {
		removeError = Object.assign(new Error("removal already in progress"), {
			statusCode: 409,
		});
		await expect(backend().removeContainer("sbx-a")).resolves.toBe(false);
		removeError = null;
	});

	it("removes a fork's image with its last fork, and only a fork's", async () => {
		removedImages.length = 0;
		await backend().removeContainer("sbx-a");
		expect(removedImages).toEqual([]);

		// fork() has already dropped the image's name: it is removed by ID.
		container.imageId = "sha256:fork";
		container.imageName = "sandbox-fork-abc123:latest";
		await backend().removeContainer("sbx-a");
		expect(removedImages).toEqual(["sha256:fork"]);

		// Docker refuses while a sibling fork still uses the image.
		imageRemoveError = Object.assign(new Error("image is in use"), {
			statusCode: 409,
		});
		await expect(backend().removeContainer("sbx-a")).resolves.toBe(true);
		imageRemoveError = null;
		container.imageId = "sha256:base";
		container.imageName = "sandbox-base:latest";
	});
});
