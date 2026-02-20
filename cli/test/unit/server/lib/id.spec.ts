import { describe, expect, it } from "vitest";
import { generateAccessToken, generateSandboxId } from "../../../../src/server/lib/id.ts";

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
