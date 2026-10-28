import { describe, expect, it } from "vitest";
import { UnsupportedError } from "../../../../src/server/errors.ts";
import {
	type LifecycleCapabilities,
	lifecycleFromCreate,
	verifyFileSignature,
} from "../../../../src/server/services/lifecycle.ts";

const docker: LifecycleCapabilities = {
	type: "docker",
	supportsPause: true,
	supportsFilesystemPause: true,
};
const tart: LifecycleCapabilities = {
	type: "tart",
	supportsPause: true,
	supportsFilesystemPause: false,
};
const shuru: LifecycleCapabilities = {
	type: "shuru",
	supportsPause: false,
	supportsFilesystemPause: false,
};

describe("lifecycleFromCreate", () => {
	it("accepts the body E2B SDK 2.31 sends by default", () => {
		const lifecycle = lifecycleFromCreate(
			{
				secure: true,
				allow_internet_access: true,
				autoPause: false,
				autoResume: { enabled: false },
			},
			docker,
		);
		expect(lifecycle).toEqual({
			autoPause: false,
			keepMemory: true,
			autoResume: false,
			secure: true,
			trafficAccessToken: null,
		});
	});

	it("accepts the body E2B SDK 2.61 sends by default, with every option unset", () => {
		expect(lifecycleFromCreate({}, docker)).toMatchObject({
			autoPause: false,
			secure: true,
		});
	});

	it("honors lifecycle onTimeout pause with autoResume", () => {
		expect(
			lifecycleFromCreate(
				{
					autoPause: true,
					autoPauseMemory: true,
					autoResume: { enabled: true },
				},
				docker,
			),
		).toMatchObject({ autoPause: true, keepMemory: true, autoResume: true });
	});

	it("honors a filesystem-only auto-pause where the backend supports it", () => {
		expect(
			lifecycleFromCreate({ autoPause: true, autoPauseMemory: false }, docker),
		).toMatchObject({ autoPause: true, keepMemory: false });
		expect(() =>
			lifecycleFromCreate({ autoPause: true, autoPauseMemory: false }, tart),
		).toThrow(/autoPauseMemory: false on the tart backend/);
	});

	it("rejects autoPauseMemory: false without autoPause, as E2B does", () => {
		expect(() =>
			lifecycleFromCreate({ autoPauseMemory: false }, docker),
		).toThrow(/autoPauseMemory requires autoPause/);
	});

	it("rejects autoPause on a backend that cannot pause", () => {
		expect(() => lifecycleFromCreate({ autoPause: true }, shuru)).toThrow(
			/autoPause on the shuru backend/,
		);
		expect(lifecycleFromCreate({ autoPause: false }, shuru).autoPause).toBe(
			false,
		);
	});

	it("rejects autoResume without a memory-keeping auto-pause", () => {
		expect(() =>
			lifecycleFromCreate({ autoResume: { enabled: true } }, docker),
		).toThrow(/autoResume requires autoPause/);
		expect(() =>
			lifecycleFromCreate(
				{ autoPause: true, autoPauseMemory: false, autoResume: true },
				docker,
			),
		).toThrow(/keeps memory/);
	});

	it("issues a traffic access token when public traffic is not allowed", () => {
		const closed = lifecycleFromCreate(
			{ network: { allowPublicTraffic: false } },
			docker,
		);
		expect(closed.trafficAccessToken).toMatch(/^[\w-]{32}$/);
		expect(
			lifecycleFromCreate({ network: { allowPublicTraffic: true } }, docker)
				.trafficAccessToken,
		).toBeNull();
	});

	it.each([
		[{ allow_internet_access: false }, "allow_internet_access"],
		[{ network: { allowOut: ["1.1.1.1"] } }, "network.allowOut"],
		[{ network: { denyOut: ["0.0.0.0/0"] } }, "network.denyOut"],
		[{ network: { maskRequestHost: "x" } }, "network.maskRequestHost"],
		[{ mcp: { github: {} } }, "mcp"],
		[{ iam: { tokens: { a: {} } } }, "iam"],
		[{ volumeMounts: [{ name: "v", path: "/data" }] }, "volumeMounts"],
	])("rejects %j and names %s", (body, field) => {
		let error: unknown;
		try {
			lifecycleFromCreate(body, docker);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(UnsupportedError);
		expect((error as Error).message).toContain(field);
	});

	it("lists every unsupported option in one error", () => {
		expect(() =>
			lifecycleFromCreate(
				{ allow_internet_access: false, mcp: { a: {} }, volumeMounts: [{}] },
				docker,
			),
		).toThrow(/allow_internet_access.*mcp.*volumeMounts/);
	});

	it("treats empty or null optional objects as unset", () => {
		expect(() =>
			lifecycleFromCreate(
				{
					mcp: {},
					iam: null,
					volumeMounts: [],
					network: { allowOut: undefined },
				},
				docker,
			),
		).not.toThrow();
	});
});

describe("verifyFileSignature", () => {
	// Vectors computed independently with Python's hashlib:
	// "v1_" + base64(sha256(raw)).rstrip("=")
	it("accepts a signature without expiration", () => {
		expect(
			verifyFileSignature({
				signature: "v1_HB2bgZ+RgifWQVkD4WDT8wNBFTVrggZWSRD5EqI0H/0",
				path: "/home/user/a.txt",
				operation: "read",
				user: "user",
				accessToken: "tok123",
				expiration: null,
			}),
		).toBe(true);
	});

	it("accepts an unexpired signature and rejects it after expiry", () => {
		const signed = {
			signature: "v1_373w4F8xFl3bg1cS1IIqbSP4gIBWzPxIe/lI7pVcSn8",
			path: "/tmp/up.bin",
			operation: "write" as const,
			user: "",
			accessToken: "tok123",
			expiration: "1900000000",
		};
		expect(verifyFileSignature({ ...signed, nowSec: 1_899_999_999 })).toBe(
			true,
		);
		expect(verifyFileSignature({ ...signed, nowSec: 1_900_000_000 })).toBe(
			true,
		);
		expect(verifyFileSignature({ ...signed, nowSec: 1_900_000_001 })).toBe(
			false,
		);
	});

	it("rejects a signature for another path, operation, user, or token", () => {
		const base = {
			signature: "v1_HB2bgZ+RgifWQVkD4WDT8wNBFTVrggZWSRD5EqI0H/0",
			path: "/home/user/a.txt",
			operation: "read" as const,
			user: "user",
			accessToken: "tok123",
			expiration: null,
		};
		expect(verifyFileSignature({ ...base, path: "/etc/passwd" })).toBe(false);
		expect(verifyFileSignature({ ...base, operation: "write" })).toBe(false);
		expect(verifyFileSignature({ ...base, user: "root" })).toBe(false);
		expect(verifyFileSignature({ ...base, accessToken: "other" })).toBe(false);
		expect(verifyFileSignature({ ...base, signature: "v1_short" })).toBe(false);
	});
});
