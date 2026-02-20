import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigMock = vi.fn();
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

// Mock the server import to avoid actually starting a server
vi.mock("../../../src/server/index.ts", () => ({}));

const { run } = await import("../../../src/commands/serve.ts");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe("serve command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processExitMock.mockImplementation((code) => {
      throw new ExitError(code as number);
    });
    // Clear env vars between tests
    delete process.env.API_KEYS;
  });

  it("exits with error if not initialized", async () => {
    readConfigMock.mockReturnValue(null);

    await expect(run([])).rejects.toThrow(ExitError);

    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("sets env vars from config and imports server", async () => {
    readConfigMock.mockReturnValue({
      apiKey: "sk-sandbox-abc",
    });

    await run([]);

    expect(process.env.API_KEYS).toBe("sk-sandbox-abc");
  });
});
