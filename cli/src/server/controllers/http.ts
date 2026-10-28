import { OpenAPIRoute, type OpenAPIRouteSchema } from "chanfana";
import type { Context } from "hono";
import { NotFoundError, RetryableError, UnsupportedError } from "../errors.ts";

/** The host the client used, so the SDK's getHost() builds URLs back to this server. */
export function requestContext(c: Context) {
	return { domain: c.req.header("host") ?? null };
}

/** The scheme and host the client used, for URLs it will call back. */
export function requestOrigin(c: Context) {
	const proto =
		c.req.header("x-forwarded-proto") ??
		new URL(c.req.url).protocol.slice(0, -1);
	return `${proto}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

/** Maps service errors to E2B-style error bodies. */
export function errorResponse(c: Context, err: unknown) {
	if (err instanceof NotFoundError) {
		return c.json({ code: 404, error: "not_found", message: err.message }, 404);
	}
	if (err instanceof UnsupportedError) {
		return c.json(
			{ code: 400, error: "unsupported", message: err.message },
			400,
		);
	}
	if (err instanceof RetryableError) {
		c.header("Retry-After", String(err.retryAfterSec));
		c.header("Should-Retry", "true");
		return c.json(
			{ code: 503, error: "unavailable", message: err.message },
			503,
		);
	}
	// Anything else is a server-side failure; say what it was.
	console.error(err);
	const message = err instanceof Error ? err.message : String(err);
	return c.json({ code: 500, error: "internal", message }, 500);
}

/** A documented route whose handler's service errors become E2B error bodies. */
export function endpoint(
	schema: OpenAPIRouteSchema,
	handle: (c: Context) => Promise<Response>,
) {
	return class extends OpenAPIRoute {
		override schema = schema;
		override async handle(c: Context) {
			try {
				return await handle(c);
			} catch (err) {
				return errorResponse(c, err);
			}
		}
	};
}

/** For an E2B API this server deliberately does not provide. */
export function notProvided(c: Context, what: string) {
	return c.json(
		{
			code: 501,
			error: "not_implemented",
			message: `${what} are not supported by this server`,
		},
		501,
	);
}
