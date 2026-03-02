import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
  config: {
    dockerSocket: "/var/run/docker.sock",
    envdPort: 49983,
    defaultTimeoutSec: 300,
  },
}));

import { createBackend } from "../../../../src/server/services/backend.ts";
import { DockerService } from "../../../../src/server/services/docker.ts";
import { ShuruBackend } from "../../../../src/server/services/shuru.ts";

describe("createBackend", () => {
  it("returns DockerService for 'docker'", () => {
    const backend = createBackend("docker", {
      dockerSocket: "/var/run/docker.sock",
    });
    expect(backend).toBeInstanceOf(DockerService);
    expect(backend.type).toBe("docker");
  });

  it("returns ShuruBackend for 'shuru'", () => {
    const backend = createBackend("shuru", {});
    expect(backend).toBeInstanceOf(ShuruBackend);
    expect(backend.type).toBe("shuru");
  });

  it("throws for unknown backend", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createBackend("unknown" as any, {})).toThrow(
      "Unknown backend",
    );
  });
});
