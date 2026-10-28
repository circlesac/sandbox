import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
  config: {
    dockerSocket: "/var/run/docker.sock",
    envdPort: 49983,
    defaultTimeoutSec: 300,
  },
}));

import {
  createBackend,
  createBackends,
} from "../../../../src/server/services/backend.ts";
import { DockerService } from "../../../../src/server/services/docker.ts";
import { ShuruBackend } from "../../../../src/server/services/shuru.ts";
import { TartBackend } from "../../../../src/server/services/tart.ts";

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

describe("createBackends", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the tart macOS backend when tart is installed", () => {
    vi.spyOn(TartBackend, "isAvailable").mockReturnValue(true);

    const backends = createBackends({ linux: "docker", macos: "tart" });

    expect(backends.linux).toBeInstanceOf(DockerService);
    expect(backends.macos).toBeInstanceOf(TartBackend);
  });

  it("disables the tart macOS backend when tart is not installed", () => {
    vi.spyOn(TartBackend, "isAvailable").mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const backends = createBackends({ linux: "docker", macos: "tart" });

    expect(backends.macos).toBeUndefined();
    expect(backends.linux).toBeInstanceOf(DockerService);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never probes for tart when no macOS backend is requested", () => {
    const isAvailable = vi.spyOn(TartBackend, "isAvailable");

    const backends = createBackends({ linux: "docker" });

    expect(backends.macos).toBeUndefined();
    expect(isAvailable).not.toHaveBeenCalled();
  });
});
