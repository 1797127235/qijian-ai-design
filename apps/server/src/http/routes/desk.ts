import type { Hono } from "hono";
import { z } from "zod";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { CanvasGenerateService } from "../../services/canvas-generate-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import { body } from "./shared.js";

export function registerDeskRoutes(app: Hono, deps: {
  desks: DeskStateService;
  artifacts: ArtifactService;
  generate?: CanvasGenerateService;
}) {
  app.get("/api/projects/:id/desk", async (c) => c.json(await deps.desks.snapshot(c.req.param("id"))));

  app.patch("/api/projects/:id/desk", async (c) => {
    const input = await body(c.req.raw, z.object({
      viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) }),
    }));
    return c.json({ viewport: await deps.desks.setViewport(c.req.param("id"), input.viewport) });
  });

  app.patch("/api/projects/:id/desk/objects/:artifactId", async (c) => {
    const patch = await body(c.req.raw, z.object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      rot: z.number().finite().optional(),
      w: z.number().positive().optional(),
    }).refine((value) => Object.keys(value).length > 0));
    return c.json(await deps.desks.moveObject(c.req.param("id"), c.req.param("artifactId"), patch));
  });

  app.delete("/api/projects/:id/desk/objects/:artifactId", async (c) => {
    return c.json(await deps.artifacts.deletePlaced(c.req.param("id"), c.req.param("artifactId")));
  });

  app.post("/api/projects/:id/desk/connections", async (c) => {
    const input = await body(c.req.raw, z.object({
      from: z.string().uuid(),
      to: z.string().uuid(),
      clientOpId: z.string().min(1).max(80).optional(),
      connectionId: z.string().uuid().optional(),
    }));
    const connection = await deps.desks.createConnection(
      c.req.param("id"),
      input.from,
      input.to,
      input.clientOpId,
      input.connectionId,
    );
    return c.json({ connection }, 201);
  });

  app.delete("/api/projects/:id/desk/connections/:connectionId", async (c) => {
    return c.json(await deps.desks.deleteConnection(c.req.param("id"), c.req.param("connectionId")));
  });

  app.post("/api/projects/:id/generate-image", async (c) => {
    if (!deps.generate) return c.json({ error: { code: "NOT_CONFIGURED", message: "生图服务未配置", retryable: false } }, 503);
    const input = await body(c.req.raw, z.object({
      prompt: z.string().max(4000).default(""),
      sourceArtifactId: z.string().uuid(),
      clientOpId: z.string().min(1).max(80),
    }));
    const result = await deps.generate.generate({
      projectId: c.req.param("id"),
      sourceArtifactId: input.sourceArtifactId,
      prompt: input.prompt,
      clientOpId: input.clientOpId,
    });
    return c.json(result, result.status === "failed" ? 200 : 201);
  });
}
