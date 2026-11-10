export interface PollOptions {
	timeoutMs: number;
	intervalMs: number;
}

export async function pollUntil<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	opts: PollOptions,
): Promise<T> {
	const controller = new AbortController();
	const error = new Error(`pollUntil timed out after ${opts.timeoutMs}ms`);
	const deadline = Date.now() + opts.timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort(error);
			reject(error);
		}, opts.timeoutMs);
	});
	const poll = async () => {
		while (!controller.signal.aborted && Date.now() < deadline) {
			try {
				return await fn(controller.signal);
			} catch {
				if (
					controller.signal.aborted ||
					Date.now() + opts.intervalMs >= deadline
				)
					throw error;
				await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
			}
		}
		throw error;
	};
	try {
		return await Promise.race([poll(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
