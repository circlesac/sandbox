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
	return { state, metadata };
}

/** Pages through a list with an opaque offset token, as E2B's x-next-token. */
function page<T>(c: Context, items: T[]): T[] {
	const limit = Number(c.req.query("limit") ?? 0) || items.length;
	const token = c.req.query("nextToken");
	const offset = token
		? Number(Buffer.from(token, "base64url").toString()) || 0
		: 0;
	const slice = items.slice(offset, offset + limit);
	if (offset + limit < items.length) {
		c.header(
			"x-next-token",
			Buffer.from(String(offset + limit)).toString("base64url"),
		);
	}
	return slice;
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
	async (c) => c.json(page(c, await sandboxes.list(listFilters(c))), 200),
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
				limit: z.string().optional(),
				nextToken: z.string().optional(),
			}),
		},
		responses: { 200: { description: "Snapshots" } },
	},
	async (c) => {
		if (!templates)
			throw new UnsupportedError("Snapshots need the Docker backend");
		const all = await templates.listSnapshots(c.req.query("sandboxID"));
		return c.json(page(c, all), 200);
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
			throw new NotFoundError(`Sandbox ${id} not found`);
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
}
