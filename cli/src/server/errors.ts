export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

export class UnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedError";
	}
}

/** The request can succeed if retried later, for example once an image download finishes. */
export class RetryableError extends Error {
	constructor(
		message: string,
		readonly retryAfterSec: number,
	) {
		super(message);
		this.name = "RetryableError";
	}
}

/** The sandbox's state does not allow the request, for example pausing a paused one. */
export class ConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}
