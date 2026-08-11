import type { Hono } from "hono";
import { z } from "zod";
import type { ProjectMemoryService } from "../../agent/memory/service.js";
import { body } from "./shared.js";

const writeSchema = z.object({
  stableKey: z.string().min(1).max(300),
  family: z.enum([
    "project_truth", "design_intent", "design_decision", "visual_system",
    "decision_history", "open_matter", "project_procedure", "generation_learning",
  ]),
  summary: z.string().min(1).max(2_000),
  body: z.string().max(8_000).optional(),
});

export function registerMemoryRoutes(app: Hono, memory: ProjectMemoryService) {
  app.get("/api/projects/:id/memory", async (c) => c.json(await memory.get(c.req.param("id"))));

  app.get("/api/projects/:id/memory/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) return c.json({ error: "q is required" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10) || 10, 1), 20);
    return c.json(await memory.search(c.req.param("id"), query, limit));
  });

  app.post("/api/projects/:id/memory", async (c) => {
    const input = await body(c.req.raw, writeSchema);
    return c.json(await memory.write(c.req.param("id"), {
      stableKey: input.stableKey,
      family: input.family,
      summary: input.summary,
      body: input.body ?? input.summary,
    }), 201);
  });

  app.delete("/api/projects/:id/memory/:stableKey", async (c) => {
    const stableKey = decodeURIComponent(c.req.param("stableKey"));
    const result = await memory.forget(c.req.param("id"), stableKey);
    if (!result.forgotten) return c.json({ error: "记忆条目不存在", stableKey, revision: result.state.revision }, 404);
    return c.json(result.state);
  });
}
