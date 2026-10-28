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
