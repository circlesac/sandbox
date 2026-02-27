import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigMock = vi.fn();
const writeConfigMock = vi.fn();
const processExitMock = vi
  .spyOn(process, "exit")
  .mockImplementation(() => undefined as never);

vi.mock("../../../src/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/config.ts")>();
  return {
    ...actual,
    readConfig: readConfigMock,
    writeConfig: writeConfigMock,
  };
});

// Mock the server import to avoid actually starting a server
vi.mock("../../../src/server/index.ts", () => ({}));

const { run } = await import("../../../src/commands/serve.ts");

describe("serve command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env vars between tests
    delete process.env.API_KEYS;
    delete process.env.SANDBOX_BACKEND;
  });

  it("auto-generates config on first run", async () => {
    readConfigMock.mockReturnValue(null);

    await run([]);

    expect(writeConfigMock).toHaveBeenCalledOnce();
    const written = writeConfigMock.mock.calls[0][0];
    expect(written.apiKey).toMatch(/^sk-sandbox-/);
    expect(process.env.API_KEYS).toBe(written.apiKey);
  });

  it("reuses existing config", async () => {
    readConfigMock.mockReturnValue({ apiKey: "sk-sandbox-abc" });

    await run([]);

    expect(writeConfigMock).not.toHaveBeenCalled();
    expect(process.env.API_KEYS).toBe("sk-sandbox-abc");
  });

  it("sets SANDBOX_BACKEND env var when backend is configured", async () => {
    readConfigMock.mockReturnValue({
      apiKey: "sk-sandbox-abc",
      backend: "shuru",
    });

    await run([]);

    expect(process.env.SANDBOX_BACKEND).toBe("shuru");
  });

  it("does not set SANDBOX_BACKEND when backend is not configured", async () => {
    readConfigMock.mockReturnValue({
      apiKey: "sk-sandbox-abc",
    });

    await run([]);

    expect(process.env.SANDBOX_BACKEND).toBeUndefined();
  });
});
