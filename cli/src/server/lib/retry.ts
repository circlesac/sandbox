export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: PollOptions,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch {
      if (Date.now() + opts.intervalMs >= deadline) {
        throw new Error(
          `pollUntil timed out after ${opts.timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
  }

  throw new Error(`pollUntil timed out after ${opts.timeoutMs}ms`);
}
