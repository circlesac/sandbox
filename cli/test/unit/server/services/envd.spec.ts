import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
	config: {
		envdHealthTimeoutMs: 3_000,
		envdHealthIntervalMs: 100,
		defaultUser: "user",
	},
}));

const { EnvdService } = await import("../../../../src/server/services/envd.ts");

/** An envd that accepts connections and never answers, like a VM still resuming. */
let silent: Server;
let port: number;

beforeAll(async () => {
	silent = createServer(() => {});
	await new Promise<void>((resolve) => silent.listen(0, resolve));
	port = (silent.address() as AddressInfo).port;
});

afterAll(() => {
	silent.closeAllConnections();
	silent.close();
});

describe("EnvdService", () => {
	it("gives up on an envd that never answers within the health timeout", async () => {
		const started = Date.now();
		await expect(new EnvdService().waitForHealth(port)).rejects.toThrow(
			/timed out/,
		);
		expect(Date.now() - started).toBeLessThan(6_000);
	}, 10_000);
});
