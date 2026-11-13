import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../../../../src/server/lib/retry.ts";

afterEach(() => vi.useRealTimers());
describe("pollUntil", () => {
	it("bounds a pending attempt and aborts its signal without retrying later", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const attempt = vi.fn((s: AbortSignal) => {
			signal = s;
			return new Promise<void>(() => {});
		});
		const result = pollUntil(attempt, { timeoutMs: 100, intervalMs: 10 });
		const failure = expect(result).rejects.toThrow("timed out after 100ms");
		await vi.advanceTimersByTimeAsync(100);
		await failure;
		expect(signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(attempt).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("retries failures and clears its deadline timer after success", async () => {
		vi.useFakeTimers();
		const attempt = vi
			.fn()
			.mockRejectedValueOnce(new Error("not ready"))
			.mockResolvedValueOnce("ready");
		const result = pollUntil(attempt, { timeoutMs: 100, intervalMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		expect(await result).toBe("ready");
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
