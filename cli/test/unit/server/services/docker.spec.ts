import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/server/config.ts", () => ({
  config: {
    dockerSocket: "/var/run/docker.sock",
    envdPort: 49983,
    defaultTimeoutSec: 300,
  },
}));

const listContainers = vi.fn();
const inspect = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const remove = vi.fn();

vi.mock("dockerode", () => ({
  default: class {
    listContainers = listContainers;
    getContainer() {
      return { inspect, start, stop, remove };
    }
  },
}));

const { DockerService } = await import(
  "../../../../src/server/services/docker.ts"
);

function containerInfo(startedAt: string) {
  return {
    Id: "container-1",
    Name: "/sbx-test",
    Created: "2026-07-28T00:00:00.000Z",
    Config: {
      Labels: {
        "e2b.sandbox-id": "sbx-test",
        "e2b.access-token": "token-test",
        "e2b.template-id": "base",
        "e2b.created-at": "2026-07-28T00:00:00.000Z",
        "e2b.timeout": "300",
      },
    },
    State: { Running: true, StartedAt: startedAt },
    NetworkSettings: {
      Ports: { "49983/tcp": [{ HostPort: "54321" }] },
    },
  };
}

describe("DockerService timeout anchor", () => {
  let backend: InstanceType<typeof DockerService>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    backend = new DockerService({ socketPath: "/var/run/docker.sock" });
  });

  it("uses the latest Docker start time when reconciling a running sandbox", async () => {
    listContainers.mockResolvedValue([
      {
        Id: "container-1",
        State: "running",
        Labels: { "e2b.sandbox-id": "sbx-test" },
        Ports: [],
      },
    ]);
    inspect.mockResolvedValue(containerInfo("2026-07-28T01:00:00.000Z"));

    const sandboxes = await backend.listSandboxes({ state: "running" });

    expect(sandboxes[0]?.createdAt).toBe("2026-07-28T01:00:00.000Z");
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("refreshes the timeout anchor when an existing container is connected", async () => {
    vi.setSystemTime(new Date("2026-07-28T02:00:00.000Z"));
    start.mockResolvedValue(undefined);
    inspect.mockResolvedValue(containerInfo("2026-07-28T01:00:00.000Z"));

    await backend.startContainer("sbx-test");
    backend.refreshTimeout("sbx-test", 900);
    const sandbox = await backend.inspectSandbox("sbx-test");

    expect(sandbox?.createdAt).toBe("2026-07-28T02:00:00.000Z");
    expect(sandbox?.timeoutSec).toBe(900);
  });
});
