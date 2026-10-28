import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";
import {
	generateAccessToken,
	generateImageSuffix,
	generateSandboxId,
	isImageName,
} from "../../../../src/server/lib/id.ts";

describe("generateSandboxId", () => {
	it("starts with sbx- prefix", () => {
		const id = generateSandboxId();
		expect(id).toMatch(/^sbx-/);
	});

	it("has consistent length", () => {
		const id = generateSandboxId();
		expect(id.length).toBe(4 + 12); // "sbx-" + 12 chars
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateSandboxId()));
		expect(ids.size).toBe(100);
	});
});

describe("generateAccessToken", () => {
	it("is 32 characters", () => {
		const token = generateAccessToken();
		expect(token.length).toBe(32);
	});

	it("generates unique tokens", () => {
		const tokens = new Set(
			Array.from({ length: 100 }, () => generateAccessToken()),
		);
		expect(tokens.size).toBe(100);
	});
});

describe("isImageName", () => {
	it.each(["base", "my-app", "app.v2", "a_b", "a__b", "a---b", "snapshot-x9"])(
		"accepts %s",
		(name) => expect(isImageName(name)).toBe(true),
	);

	it.each([
		"",
		"My-App",
		"-app",
		"app-",
		"app_",
		"a_-b",
		"a___b",
		"a b",
		"x".repeat(129),
	])("rejects %j", (name) => expect(isImageName(name)).toBe(false));
});

describe("generateImageSuffix", () => {
	it("always yields a valid image name, which lowercased nanoid IDs did not", () => {
		const samples = Array.from(
			{ length: 5000 },
			() => `fork-${generateImageSuffix()}`,
		);
		expect(samples.every(isImageName)).toBe(true);

		// The previous suffix, nanoid(10).toLowerCase(), can end in "-" or "_"
		// or put "_-" together; Docker rejects such names ("invalid reference format").
		const previous = Array.from(
			{ length: 5000 },
			() => `fork-${nanoid(10).toLowerCase()}`,
		);
		expect(previous.some((name) => !isImageName(name))).toBe(true);
	});
});
