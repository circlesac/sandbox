import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlService } from "../../../../src/server/services/ttl.ts";

describe("TtlService", () => {
  let ttl: TtlService;

  beforeEach(() => {
    vi.useFakeTimers();
    ttl = new TtlService();
  });

  afterEach(() => {
    ttl.clearAll();
    vi.useRealTimers();
  });

  it("calls onExpire after timeout", () => {
    const onExpire = vi.fn();
    ttl.start("sbx-1", 10, onExpire);

    vi.advanceTimersByTime(9999);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("clears timer so it does not fire", () => {
    const onExpire = vi.fn();
    ttl.start("sbx-1", 10, onExpire);
    ttl.clear("sbx-1");

    vi.advanceTimersByTime(20000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("update replaces existing timer", () => {
    const onExpire1 = vi.fn();
    const onExpire2 = vi.fn();

    ttl.start("sbx-1", 10, onExpire1);
    ttl.update("sbx-1", 20, onExpire2);

    vi.advanceTimersByTime(10000);
    expect(onExpire1).not.toHaveBeenCalled();
    expect(onExpire2).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10000);
    expect(onExpire2).toHaveBeenCalledOnce();
  });

  it("clearAll stops all timers", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ttl.start("sbx-1", 10, fn1);
    ttl.start("sbx-2", 10, fn2);
    ttl.clearAll();

    vi.advanceTimersByTime(20000);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it("clear on non-existent id is a no-op", () => {
    expect(() => ttl.clear("non-existent")).not.toThrow();
  });
});
