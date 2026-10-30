import type { fromHono } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { NotFoundError, UnsupportedError } from "../../errors.ts";
import type { SandboxService } from "../../services/sandbox.ts";
import type { TemplateService } from "../../services/templates.ts";
import { endpoint, requestContext } from "../http.ts";
import { SandboxIdParamSchema } from "./schemas.ts";

let sandboxes: SandboxService;
let templates: TemplateService | null = null;

export function setExtraSandboxService(service: SandboxService) {
	sandboxes = service;
}

export function setSnapshotTemplateService(service: TemplateService | null) {
	templates = service;
}

const tags = ["Sandboxes"];

/** E2B's list filters: repeated or comma-separated state, metadata as `k=v&k=v`. */
function listFilters(c: Context) {
	const state = c.req
		.queries("state")
		?.flatMap((value) => value.split(","))
		.filter(Boolean);
	const raw = c.req.query("metadata");
	const metadata = raw
		? Object.fromEntries(new URLSearchParams(raw))
		: undefined;
	return {
		state,
		metadata,
		template: c.req.query("template"),
		startedAfter: c.req.query("startedAfter"),
	};
}

/**
 * Pages through a list sorted by `compare`, as E2B's x-next-token. The
 * token holds the last item's sort key, not an offset, so a sandbox created
 * or removed between pages neither repeats nor skips another.
 */
function page<T>(
	c: Context,
	items: T[],
	compare: (a: T, b: T) => number,
	keyOf: (item: T) => Partial<T>,
): T[] {
	const limit = Number(c.req.query("limit") ?? 0) || items.length;
	const token = c.req.query("nextToken");
	let rest = items;
	if (token) {
		// Anything this server did not issue, malformed or of the wrong shape,
		// is the client's error, not a 500 from the comparison.
		try {
			const after = JSON.parse(Buffer.from(token, "base64url").toString()) as T;
			if (!after || typeof after !== "object") throw new Error();
			// Every field the key holds must be there, as this server wrote it.
			const sample = items[0];
			if (sample !== undefined) {
				for (const [field, value] of Object.entries(keyOf(sample))) {
					const given = (after as Record<string, unknown>)[field];
					if (typeof given !== typeof value) throw new Error();
				}
			}
			rest = items.filter((item) => compare(item, after) > 0);
		} catch {
			throw new UnsupportedError("Invalid nextToken");
		}
	}
	const slice = rest.slice(0, limit);
	const last = slice[slice.length - 1];
	if (last !== undefined && rest.length > limit) {
		c.header(
			"x-next-token",
			Buffer.from(JSON.stringify(keyOf(last))).toString("base64url"),
		);
	}
	return slice;
}

/** The order SandboxService.list returns: newest first, then by ID. */
function bySandboxOrder(
	a: { startedAt: string; sandboxID: string },
	b: { startedAt: string; sandboxID: string },
) {
	return (
		b.startedAt.localeCompare(a.startedAt) ||
		a.sandboxID.localeCompare(b.sandboxID)
	);
}

export const ListSandboxesFiltered = endpoint(
	{
		tags,
		summary: "List sandboxes, filtered by state and metadata",
		request: {
			query: z.object({
				state: z.string().optional().describe("running or paused; repeatable"),
				metadata: z.string().optional().describe("URL-encoded key=value pairs"),
				limit: z.string().optional(),
				nextToken: z.string().optional(),
			}),
		},
		responses: { 200: { description: "Sandboxes" } },
	},
	async (c) => {
		const all = await sandboxes.list(listFilters(c));
		// E2B reports how many matching sandboxes run, across every page.
		c.header(
			"X-Total-Running",
			String(all.filter((s) => s.state === "running").length),
		);
		return c.json(
			page(c, all, bySandboxOrder, ({ startedAt, sandboxID }) => ({
				startedAt,
				sandboxID,
			})),
			200,
		);
	},
);

export const CreateSnapshot = endpoint(
	{
		tags,
		summary: "Save a sandbox's filesystem as a snapshot template",
		request: {
			params: SandboxIdParamSchema,
			body: {
				content: {
					"application/json": {
						schema: z.object({
							name: z.string().optional(),
							memory: z.boolean().optional(),
						}),
					},
				},
			},
		},
		responses: { 201: { description: "Snapshot created" } },
	},
	async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sandboxes.snapshot(
			c.req.param("sandboxID") ?? "",
			body,
		);
		return c.json(result, 201);
	},
);

export const ListSnapshots = endpoint(
	{
		tags,
		summary: "List snapshot templates",
		request: {
			query: z.object({
				sandboxID: z.string().optional(),
				name: z.string().optional().describe("Name, optionally with :<tag>"),
				limit: z.string().optional(),
				nextToken: z.string().optional(),
			}),
		},
		responses: { 200: { description: "Snapshots" } },
	},
	async (c) => {
		if (!templates)
			throw new UnsupportedError("Snapshots need the Docker backend");
		const bySnapshotId = (
			a: { snapshotID: string },
			b: { snapshotID: string },
		) => a.snapshotID.localeCompare(b.snapshotID);
		const all = (
			await templates.listSnapshots(
				c.req.query("sandboxID"),
				c.req.query("name"),
			)
		).sort(bySnapshotId);
		return c.json(
			page(c, all, bySnapshotId, ({ snapshotID }) => ({ snapshotID })),
			200,
		);
	},
);

export const ForkSandbox = endpoint(
	{
		tags,
		summary: "Fork a sandbox's filesystem into new sandboxes",
		request: {
			params: SandboxIdParamSchema,
			body: {
				content: {
					"application/json": {
						schema: z.object({
							timeout: z.number().optional(),
							count: z.number().optional(),
						}),
					},
				},
			},
		},
		responses: { 201: { description: "One result per fork" } },
	},
	async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const results = await sandboxes.fork(
			c.req.param("sandboxID") ?? "",
			body,
			requestContext(c),
		);
		return c.json(results, 201);
	},
);

export const SandboxMetrics = endpoint(
	{
		tags,
		summary: "A sandbox's current resource use",
		request: { params: SandboxIdParamSchema },
		responses: { 200: { description: "Metrics samples" } },
	},
	async (c) =>
		c.json(await sandboxes.metrics(c.req.param("sandboxID") ?? ""), 200),
);

export const SandboxesMetrics = endpoint(
	{
		tags,
		summary: "Current resource use of several sandboxes",
		request: {
			query: z.object({
				sandbox_ids: z
					.string()
					.optional()
					.describe("Repeatable or comma-separated"),
			}),
		},
		responses: { 200: { description: "Latest sample per running sandbox" } },
	},
	async (c) => {
		const ids = (c.req.queries("sandbox_ids") ?? []).flatMap((v) =>
			v.split(","),
		);
		const entries = await Promise.all(
			ids.filter(Boolean).map(async (id) => {
				const samples = await sandboxes.metrics(id).catch((err) => {
					if (err instanceof NotFoundError) return [];
					throw err;
				});
				return [id, samples.at(-1)] as const;
			}),
		);
		return c.json(
			{
				sandboxes: Object.fromEntries(
					entries.filter(([, m]) => m !== undefined),
				),
			},
			200,
		);
	},
);

export const UpdateNetwork = endpoint(
	{
		tags,
		summary: "Update a sandbox's network rules",
		request: { params: SandboxIdParamSchema },
		responses: { 204: { description: "Nothing to change" } },
	},
	async (c) => {
		const id = c.req.param("sandboxID") ?? "";
		if (!(await sandboxes.getInfo(id))) {
			throw new NotFoundError(
				`Sandbox ${id} doesn't exist or you don't have access to it`,
			);
		}
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const unsupported = Object.entries(body)
			.filter(([key, value]) => {
				if (value === undefined || value === null) return false;
				if (key === "allow_internet_access") return value !== true;
				return !(Array.isArray(value) && value.length === 0);
			})
			.map(([key]) => key);
		if (unsupported.length > 0) {
			throw new UnsupportedError(
				`Unsupported network options: ${unsupported.join(", ")}; sandboxes always have unrestricted egress`,
			);
		}
		return c.body(null, 204);
	},
);

export const RefreshSandbox = endpoint(
	{
		tags,
		summary: "Extend a running sandbox's time to live",
		request: {
			params: SandboxIdParamSchema,
			body: {
				content: {
					"application/json": {
						schema: z.object({ duration: z.number().optional() }),
					},
				},
			},
		},
		responses: { 204: { description: "Refreshed" } },
	},
	async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			duration?: number;
		};
		await sandboxes.refresh(
			c.req.param("sandboxID") ?? "",
			body.duration ?? 60,
		);
		return c.body(null, 204);
	},
);

/** Registers the endpoints beyond the core lifecycle. */
export function registerExtraSandboxRoutes(
	openapi: ReturnType<typeof fromHono>,
) {
	openapi.get("/sandboxes/metrics", SandboxesMetrics);
	openapi.post("/sandboxes/:sandboxID/snapshots", CreateSnapshot);
	openapi.get("/snapshots", ListSnapshots);
	openapi.post("/sandboxes/:sandboxID/fork", ForkSandbox);
	openapi.get("/sandboxes/:sandboxID/metrics", SandboxMetrics);
	openapi.put("/sandboxes/:sandboxID/network", UpdateNetwork);
	openapi.post("/sandboxes/:sandboxID/refreshes", RefreshSandbox);
}
