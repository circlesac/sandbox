import type { fromHono } from "chanfana";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { NotFoundError, UnsupportedError } from "../../errors.ts";
import type {
	TemplateBuildStart,
	TemplateService,
} from "../../services/templates.ts";
import {
	endpoint,
	errorResponse,
	notProvided,
	requestOrigin,
} from "../http.ts";

let templates: TemplateService | null = null;

export function setTemplateService(service: TemplateService | null) {
	templates = service;
}

function service(): TemplateService {
	if (!templates) {
		throw new UnsupportedError("Templates need the Docker backend");
	}
	return templates;
}

const tags = ["Templates"];
const TemplateParams = z.object({ templateID: z.string() });
const BuildParams = z.object({ templateID: z.string(), buildID: z.string() });

export const RequestBuild = endpoint(
	{
		tags,
		summary: "Request a template build",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							name: z.string(),
							tags: z.array(z.string()).optional(),
							cpuCount: z.number().optional(),
							memoryMB: z.number().optional(),
							minFreeDiskMb: z.number().optional(),
						}),
					},
				},
			},
		},
		responses: { 202: { description: "Build requested" } },
	},
	async (c) => c.json(service().requestBuild(await c.req.json()), 202),
);

export const FileUploadLink = endpoint(
	{
		tags,
		summary: "Get where to upload a COPY step's files",
		request: { params: z.object({ templateID: z.string(), hash: z.string() }) },
		responses: { 201: { description: "Upload link, or present when cached" } },
	},
	async (c) =>
		c.json(
			service().fileUploadLink(c.req.param("hash") ?? "", requestOrigin(c)),
			201,
		),
);

export const StartBuild = endpoint(
	{
		tags,
		summary: "Start a requested template build",
		request: { params: BuildParams },
		responses: { 202: { description: "Build started" } },
	},
	async (c) => {
		await service().startBuild(
			c.req.param("templateID") ?? "",
			c.req.param("buildID") ?? "",
			(await c.req.json()) as TemplateBuildStart,
		);
		return c.body(null, 202);
	},
);

export const BuildStatus = endpoint(
	{
		tags,
		summary: "Get a template build's status and new log entries",
		request: {
			params: BuildParams,
			query: z.object({ logsOffset: z.string().optional() }),
		},
		responses: { 200: { description: "Build status" } },
	},
	async (c) =>
		c.json(
			service().status(
				c.req.param("templateID") ?? "",
				c.req.param("buildID") ?? "",
				Number(c.req.query("logsOffset") ?? 0),
			),
			200,
		),
);

export const ResolveAlias = endpoint(
	{
		tags,
		summary: "Check whether a template name exists",
		request: { params: z.object({ alias: z.string() }) },
		responses: { 200: { description: "Template found" } },
	},
	async (c) => {
		const alias = c.req.param("alias") ?? "";
		if (!(await service().aliasExists(alias))) {
			throw new NotFoundError(`Template ${alias} not found`);
		}
		return c.json({ templateID: alias, public: false }, 200);
	},
);

export const AssignTags = endpoint(
	{
		tags,
		summary: "Tag a template build",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({ target: z.string(), tags: z.array(z.string()) }),
					},
				},
			},
		},
		responses: { 201: { description: "Tags assigned" } },
	},
	async (c) => {
		const body = (await c.req.json()) as { target: string; tags: string[] };
		return c.json(await service().assignTags(body.target, body.tags), 201);
	},
);

export const RemoveTags = endpoint(
	{
		tags,
		summary: "Remove template tags",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
					},
				},
			},
		},
		responses: { 204: { description: "Tags removed" } },
	},
	async (c) => {
		const body = (await c.req.json()) as { name: string; tags: string[] };
		await service().removeTags(body.name, body.tags);
		return c.body(null, 204);
	},
);

export const ListTags = endpoint(
	{
		tags,
		summary: "List a template's tags",
		request: { params: TemplateParams },
		responses: { 200: { description: "Tags" } },
	},
	async (c) =>
		c.json(await service().listTags(c.req.param("templateID") ?? ""), 200),
);

export const DeleteTemplate = endpoint(
	{
		tags,
		summary: "Delete a template or snapshot",
		request: { params: TemplateParams },
		responses: { 204: { description: "Deleted" } },
	},
	async (c) => {
		const id = c.req.param("templateID") ?? "";
		if (!(await service().deleteTemplate(id))) {
			throw new NotFoundError(`Template ${id} not found`);
		}
		return c.body(null, 204);
	},
);

export function registerTemplateRoutes(openapi: ReturnType<typeof fromHono>) {
	openapi.post("/v3/templates", RequestBuild);
	openapi.get("/templates/aliases/:alias", ResolveAlias);
	openapi.post("/templates/tags", AssignTags);
	openapi.delete("/templates/tags", RemoveTags);
	openapi.get("/templates/:templateID/files/:hash", FileUploadLink);
	openapi.post("/v2/templates/:templateID/builds/:buildID", StartBuild);
	openapi.get("/templates/:templateID/builds/:buildID/status", BuildStatus);
	openapi.get("/templates/:templateID/tags", ListTags);
	openapi.delete("/templates/:templateID", DeleteTemplate);
}

/**
 * Routes outside the API-key check: the file upload carries its own token in
 * the URL the server handed out, as E2B's presigned upload URLs do.
 */
export function registerTemplateUploadRoute(app: Hono) {
	app.put("/template-files/:hash", async (c: Context) => {
		try {
			await service().storeUpload(
				c.req.param("hash") ?? "",
				c.req.query("token"),
				await c.req.arrayBuffer(),
			);
			return c.body(null, 201);
		} catch (err) {
			return errorResponse(c, err);
		}
	});
}

/** E2B APIs this server does not provide answer 501 instead of 404. */
export function registerNotProvidedRoutes(app: Hono) {
	for (const path of ["/volumes", "/volumes/*", "/volumecontent/*"]) {
		app.all(path, (c) => notProvided(c, "Volumes"));
	}
	for (const path of ["/secrets", "/secrets/*"]) {
		app.all(path, (c) => notProvided(c, "Secrets"));
	}
}
