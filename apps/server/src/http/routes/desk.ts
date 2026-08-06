import type { Hono } from "hono";
import { z } from "zod";
import type { DeskStateService } from "../../services/desk-state-service.js";
import { body } from "./shared.js";

export function registerDeskRoutes(app: Hono, deps: { desks: DeskStateService }) {
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
}
