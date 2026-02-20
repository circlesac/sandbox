import { describe, it, expect, vi, beforeEach } from "vitest";

const configExistsMock = vi.fn<() => boolean>();
const writeConfigMock = vi.fn();
const isDockerInstalledMock = vi.fn<() => boolean>();
const isDockerRunningMock = vi.fn<() => boolean>();

const processExitMock = vi
  .spyOn(process, "exit")
  .mockImplementation(() => undefined as never);

vi.mock("../../../src/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/config.ts")>();
  return {
    ...actual,
    configExists: configExistsMock,
    writeConfig: writeConfigMock,
  };
});

vi.mock("../../../src/lib/checks.ts", () => ({
  isDockerInstalled: isDockerInstalledMock,
  isDockerRunning: isDockerRunningMock,
}));

// Mock readline to auto-answer prompts
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(""),
    close: () => {},
  }),
}));

const { run } = await import("../../../src/commands/init.ts");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe("init command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processExitMock.mockImplementation((code) => {
      throw new ExitError(code as number);
    });
  });

  it("exits if docker is not installed", async () => {
    configExistsMock.mockReturnValue(false);
    isDockerInstalledMock.mockReturnValue(false);

    await expect(run([])).rejects.toThrow(ExitError);

    expect(processExitMock).toHaveBeenCalledWith(1);
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it("exits if docker is not running", async () => {
    configExistsMock.mockReturnValue(false);
    isDockerInstalledMock.mockReturnValue(true);
    isDockerRunningMock.mockReturnValue(false);

    await expect(run([])).rejects.toThrow(ExitError);

    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("completes init flow and writes config with api key", async () => {
    configExistsMock.mockReturnValue(false);
    isDockerInstalledMock.mockReturnValue(true);
    isDockerRunningMock.mockReturnValue(true);

    await run([]);

    expect(writeConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: expect.stringMatching(/^sk-sandbox-/),
      }),
    );
  });
});
