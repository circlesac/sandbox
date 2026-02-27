import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigMock = vi.fn();
const execMock = vi.fn();
const isDockerRunningMock = vi.fn<() => boolean>();
const processExitMock = vi
  .spyOn(process, "exit")
  .mockImplementation(() => undefined as never);

vi.mock("../../../src/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/config.ts")>();
  return {
    ...actual,
    readConfig: readConfigMock,
  };
});

vi.mock("../../../src/lib/exec.ts", () => ({
  exec: execMock,
}));

vi.mock("../../../src/lib/checks.ts", () => ({
  isDockerRunning: isDockerRunningMock,
}));

const fetchMock = vi.spyOn(globalThis, "fetch");

const { run } = await import("../../../src/commands/status.ts");

const testConfig = {
  apiKey: "sk-sandbox-abc",
};

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe("status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processExitMock.mockImplementation((code) => {
      throw new ExitError(code as number);
    });
  });

  it("shows not configured when config is missing", async () => {
    readConfigMock.mockReturnValue(null);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await run([]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("not configured");
    logSpy.mockRestore();
  });

  it("exits with error if docker is not running", async () => {
    readConfigMock.mockReturnValue(testConfig);
    isDockerRunningMock.mockReturnValue(false);

    await expect(run([])).rejects.toThrow(ExitError);

    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("shows status when everything is healthy", async () => {
    readConfigMock.mockReturnValue(testConfig);
    isDockerRunningMock.mockReturnValue(true);

    execMock.mockReturnValueOnce({
      stdout: "abc123\ndef456\n",
      stderr: "",
      exitCode: 0,
    });

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await run([]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("healthy");
    expect(output).toContain("2");

    logSpy.mockRestore();
  });

  it("counts zero sandboxes when none are running", async () => {
    readConfigMock.mockReturnValue(testConfig);
    isDockerRunningMock.mockReturnValue(true);

    execMock.mockReturnValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await run([]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("0");
    expect(output).toContain("unreachable");

    logSpy.mockRestore();
  });
});
