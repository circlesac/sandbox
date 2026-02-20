import { describe, expect, it } from "vitest";
import { parseEnvdHostname } from "../../../../src/server/services/proxy.ts";

describe("parseEnvdHostname", () => {
  it("parses valid envd hostname", () => {
    const result = parseEnvdHostname(
      "49983-sbx-abc123def456.sandbox.circles.dev",
    );
    expect(result).toEqual({ sandboxId: "sbx-abc123def456" });
  });

  it("parses hostname with different port", () => {
    const result = parseEnvdHostname(
      "3000-sbx-xyz789.sandbox.circles.dev",
    );
    expect(result).toEqual({ sandboxId: "sbx-xyz789" });
  });

  it("returns null for control plane hostname", () => {
    const result = parseEnvdHostname("api.sandbox.circles.dev");
    expect(result).toBeNull();
  });

  it("returns null for bare hostname", () => {
    const result = parseEnvdHostname("localhost:3000");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseEnvdHostname("");
    expect(result).toBeNull();
  });

  it("handles sandbox IDs with hyphens and underscores", () => {
    const result = parseEnvdHostname(
      "49983-sbx-a1b2_c3d4-e5.sandbox.circles.dev",
    );
    expect(result).toEqual({ sandboxId: "sbx-a1b2_c3d4-e5" });
  });
});
