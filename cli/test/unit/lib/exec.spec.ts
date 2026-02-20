import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";

const spawnSyncMock = vi.fn<() => Partial<SpawnSyncReturns<string>>>();

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const { exec, execInteractive, commandExists } = await import(
  "../../../src/lib/exec.ts"
);

describe("exec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stdout, stderr, and exitCode on success", () => {
    spawnSyncMock.mockReturnValue({
      stdout: "hello\n",
      stderr: "",
      status: 0,
    });

    const result = exec("echo hello");

    expect(spawnSyncMock).toHaveBeenCalledWith("echo hello", {
      shell: true,
      encoding: "utf-8",
    });
    expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
  });

  it("returns exitCode 1 when status is null", () => {
    spawnSyncMock.mockReturnValue({
      stdout: "",
      stderr: "error",
      status: null,
    });

    const result = exec("bad-cmd");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error");
  });

  it("handles undefined stdout/stderr", () => {
    spawnSyncMock.mockReturnValue({
      stdout: undefined,
      stderr: undefined,
      status: 0,
    });

    const result = exec("empty");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("execInteractive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes stdio inherit and returns exit code", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    const code = execInteractive("docker compose up -d");

    expect(spawnSyncMock).toHaveBeenCalledWith("docker compose up -d", {
      shell: true,
      stdio: "inherit",
    });
    expect(code).toBe(0);
  });

  it("returns 1 when status is null", () => {
    spawnSyncMock.mockReturnValue({ status: null });

    expect(execInteractive("fail")).toBe(1);
  });
});

describe("commandExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when command is found", () => {
    spawnSyncMock.mockReturnValue({ stdout: "/usr/bin/docker", stderr: "", status: 0 });

    expect(commandExists("docker")).toBe(true);
  });

  it("returns false when command is not found", () => {
    spawnSyncMock.mockReturnValue({ stdout: "", stderr: "", status: 1 });

    expect(commandExists("nonexistent")).toBe(false);
  });
});
