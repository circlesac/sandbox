import { describe, it, expect, vi, beforeEach } from "vitest";

const existsSyncMock = vi.fn<(path: string) => boolean>();
const readFileSyncMock = vi.fn<(path: string, encoding: string) => string>();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const { configExists, readConfig, writeConfig, CONFIG_PATH, SANDBOX_DIR } =
  await import("../../../src/lib/config.ts");

describe("configExists", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when config file exists", () => {
    existsSyncMock.mockReturnValue(true);
    expect(configExists()).toBe(true);
    expect(existsSyncMock).toHaveBeenCalledWith(CONFIG_PATH);
  });

  it("returns false when config file is missing", () => {
    existsSyncMock.mockReturnValue(false);
    expect(configExists()).toBe(false);
  });
});

describe("readConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed config when file exists", () => {
    const config = {
      apiKey: "sk-sandbox-abc",
    };
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify(config));

    expect(readConfig()).toEqual(config);
  });

  it("returns null when file does not exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(readConfig()).toBeNull();
  });
});

describe("writeConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates directory and writes config as JSON", () => {
    const config = {
      apiKey: "sk-sandbox-abc",
    };

    writeConfig(config);

    expect(mkdirSyncMock).toHaveBeenCalledWith(SANDBOX_DIR, {
      recursive: true,
    });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      CONFIG_PATH,
      JSON.stringify(config, null, 2) + "\n",
    );
  });
});
