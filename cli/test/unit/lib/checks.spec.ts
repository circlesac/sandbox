import { describe, it, expect, vi, beforeEach } from "vitest";

const commandExistsMock = vi.fn<(name: string) => boolean>();
const execMock = vi.fn();

vi.mock("../../../src/lib/exec.ts", () => ({
  commandExists: commandExistsMock,
  exec: execMock,
}));

const { isDockerInstalled, isDockerRunning } =
  await import("../../../src/lib/checks.ts");

describe("isDockerInstalled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker command exists", () => {
    commandExistsMock.mockReturnValue(true);
    expect(isDockerInstalled()).toBe(true);
    expect(commandExistsMock).toHaveBeenCalledWith("docker");
  });

  it("returns false when docker command is missing", () => {
    commandExistsMock.mockReturnValue(false);
    expect(isDockerInstalled()).toBe(false);
  });
});

describe("isDockerRunning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker info succeeds", () => {
    execMock.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    expect(isDockerRunning()).toBe(true);
    expect(execMock).toHaveBeenCalledWith("docker info");
  });

  it("returns false when docker info fails", () => {
    execMock.mockReturnValue({ stdout: "", stderr: "error", exitCode: 1 });
    expect(isDockerRunning()).toBe(false);
  });
});
