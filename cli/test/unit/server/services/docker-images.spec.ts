import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NotFoundError,
	RetryableError,
} from "../../../../src/server/errors.ts";

vi.mock("../../../../src/server/config.ts", () => ({
	config: { envdPort: 49983, defaultTimeoutSec: 300 },
}));

const cached = new Set<string>();
const pull = vi.fn();
let finishPull: (err?: Error) => void = () => {};

vi.mock("dockerode", () => ({
	default: class {
		getImage(name: string) {
			return {
				inspect: async () => {
					if (cached.has(name)) return {};
					throw Object.assign(new Error("no such image"), { statusCode: 404 });
				},
			};
		}
		pull = pull;
		modem = {
			followProgress: (_stream: unknown, done: (err: Error | null) => void) => {
				finishPull = (err?: Error) => done(err ?? null);
			},
		};
	},
}));

const { DockerService } = await import(
	"../../../../src/server/services/docker.ts"
);

const REMOTE = "ghcr.io/circlesac/sandbox-base:latest";

function backend(imagePullWaitMs = 1_000) {
	return new DockerService({
		socketPath: "/var/run/docker.sock",
		statePath: null,
		imagePullWaitMs,
	});
}

describe("DockerService image resolution", () => {
	beforeEach(() => {
		cached.clear();
		pull.mockReset();
		pull.mockImplementation(
			(name: string, cb: (err: null, stream: object) => void) => {
				cb(null, {});
				finishPullFor = name;
			},
		);
		vi.useRealTimers();
	});

	let finishPullFor = "";

	it("uses a locally built sandbox-<template> image without contacting the registry", async () => {
		cached.add("sandbox-base:latest");
		await expect(backend().resolveImage("base")).resolves.toBe(
			"sandbox-base:latest",
		);
		expect(pull).not.toHaveBeenCalled();
	});

	it("uses a cached registry image without pulling it again", async () => {
		cached.add(REMOTE);
		await expect(backend().resolveImage("base")).resolves.toBe(REMOTE);
		expect(pull).not.toHaveBeenCalled();
	});

	it("pulls a missing image and returns it once the download finishes", async () => {
		const resolving = backend().resolveImage("base");
		await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
		cached.add(finishPullFor);
		finishPull();
		await expect(resolving).resolves.toBe(REMOTE);
	});

	it("answers with a retryable error before the wait budget runs out, and keeps downloading", async () => {
		vi.useFakeTimers();
		const docker = backend(40_000);
		const first = docker.resolveImage("base");
		const rejection = expect(first).rejects.toBeInstanceOf(RetryableError);

		await vi.advanceTimersByTimeAsync(39_999);
		expect(pull).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		await expect(first).rejects.toThrow(/still downloading; retry shortly/);

		// A retry while the same download is still running shares it.
		const retry = docker.resolveImage("base");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(pull).toHaveBeenCalledOnce();

		cached.add(REMOTE);
		finishPull();
		await expect(retry).resolves.toBe(REMOTE);
	});

	it("shares one download between concurrent creates", async () => {
		const docker = backend();
		const a = docker.resolveImage("base");
		const b = docker.resolveImage("base");
		await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
		cached.add(REMOTE);
		finishPull();
		await expect(Promise.all([a, b])).resolves.toEqual([REMOTE, REMOTE]);
		expect(pull).toHaveBeenCalledOnce();
	});

	it("reports an unknown template as not found", async () => {
		pull.mockImplementation((_name: string, cb: (err: Error) => void) =>
			cb(new Error("manifest unknown")),
		);
		await expect(backend().resolveImage("missing")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	it("prefetches only when the image is not cached", async () => {
		cached.add(REMOTE);
		const docker = backend();
		docker.prefetchImage("base");
		await new Promise((r) => setTimeout(r, 10));
		expect(pull).not.toHaveBeenCalled();

		cached.clear();
		docker.prefetchImage("base");
		await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
		finishPull();
	});
});
