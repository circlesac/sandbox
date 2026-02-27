import { OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { NotFoundError, UnsupportedError, type SandboxService } from "../../services/sandbox.ts";
import {
  ConnectBodySchema,
  CreateSandboxBodySchema,
  ErrorSchema,
  SandboxDetailSchema,
  SandboxIdParamSchema,
  SandboxResponseSchema,
  TimeoutBodySchema,
} from "./schemas.ts";

let sandboxService: SandboxService;

export function setSandboxService(service: SandboxService) {
  sandboxService = service;
}

export class CreateSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Create a new sandbox",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateSandboxBodySchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Sandbox created",
        content: {
          "application/json": {
            schema: SandboxResponseSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const body = await c.req.json();
    const result = await sandboxService.create(body);
    return c.json(result, 201);
  }
}

export class ListSandboxes extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "List all sandboxes",
    responses: {
      200: {
        description: "List of sandboxes",
        content: {
          "application/json": {
            schema: z.array(SandboxDetailSchema),
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const sandboxes = await sandboxService.list();
    return c.json(sandboxes, 200);
  }
}

export class GetSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Get sandbox details",
    request: {
      params: SandboxIdParamSchema,
    },
    responses: {
      200: {
        description: "Sandbox details",
        content: {
          "application/json": {
            schema: SandboxDetailSchema,
          },
        },
      },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    const info = await sandboxService.getInfo(id);
    if (!info) return c.json({ error: "not_found", message: `Sandbox ${id} not found` }, 404);
    return c.json(info, 200);
  }
}

export class DeleteSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Destroy a sandbox",
    request: {
      params: SandboxIdParamSchema,
    },
    responses: {
      204: { description: "Sandbox destroyed" },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    const killed = await sandboxService.kill(id);
    if (!killed) return c.json({ error: "not_found", message: `Sandbox ${id} not found` }, 404);
    return c.body(null, 204);
  }
}

export class PauseSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Pause a sandbox",
    request: {
      params: SandboxIdParamSchema,
    },
    responses: {
      204: { description: "Sandbox paused" },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    try {
      const paused = await sandboxService.pause(id);
      if (!paused) return c.json({ error: "not_found", message: `Sandbox ${id} not found` }, 404);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof UnsupportedError)
        return c.json({ error: "unsupported", message: err.message }, 501);
      throw err;
    }
  }
}

export class ResumeSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Resume a paused sandbox",
    request: {
      params: SandboxIdParamSchema,
      body: {
        content: {
          "application/json": {
            schema: ConnectBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Sandbox resumed",
        content: {
          "application/json": {
            schema: SandboxResponseSchema,
          },
        },
      },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await sandboxService.connect(id, body.timeout);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof NotFoundError)
        return c.json({ error: "not_found", message: err.message }, 404);
      if (err instanceof UnsupportedError)
        return c.json({ error: "unsupported", message: err.message }, 501);
      throw err;
    }
  }
}

export class ConnectSandbox extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Connect to a sandbox (resumes if paused)",
    request: {
      params: SandboxIdParamSchema,
      body: {
        content: {
          "application/json": {
            schema: ConnectBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Connected (already running)",
        content: {
          "application/json": {
            schema: SandboxResponseSchema,
          },
        },
      },
      201: {
        description: "Connected (resumed from paused)",
        content: {
          "application/json": {
            schema: SandboxResponseSchema,
          },
        },
      },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    const body = await c.req.json().catch(() => ({}));
    try {
      const info = await sandboxService.getInfo(id);
      const wasPaused = info?.startedAt && !info?.endAt ? false : true;
      const result = await sandboxService.connect(id, body.timeout);
      return c.json(result, wasPaused ? 201 : 200);
    } catch (err) {
      if (err instanceof NotFoundError)
        return c.json({ error: "not_found", message: err.message }, 404);
      throw err;
    }
  }
}

export class SetSandboxTimeout extends OpenAPIRoute {
  override schema = {
    tags: ["Sandboxes"],
    summary: "Update sandbox timeout",
    request: {
      params: SandboxIdParamSchema,
      body: {
        content: {
          "application/json": {
            schema: TimeoutBodySchema,
          },
        },
      },
    },
    responses: {
      204: { description: "Timeout updated" },
      404: {
        description: "Sandbox not found",
        content: {
          "application/json": {
            schema: ErrorSchema,
          },
        },
      },
    },
  };

  override async handle(c: Context) {
    const id = c.req.param("sandboxID");
    const body = await c.req.json();
    try {
      await sandboxService.setTimeout(id, body.timeout);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof NotFoundError)
        return c.json({ error: "not_found", message: err.message }, 404);
      throw err;
    }
  }
}
