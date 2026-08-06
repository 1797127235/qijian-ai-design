import type { Hono } from "hono";
import { z } from "zod";
import type { AgentSessionRegistry } from "../../agent/session-registry.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import type { FileStorage } from "../../services/file-storage.js";
import { body } from "./shared.js";

export function registerProjectRoutes(
  app: Hono,
  deps: {
    desks: DeskStateService;
    files: FileStorage;
    sessions: AgentSessionRegistry;
  },
) {
  app.get("/api/projects", async (c) => c.json(await deps.desks.listProjects()));

  app.post("/api/projects", async (c) => {
    const input = await body(c.req.raw, z.object({ name: z.string().trim().min(1).max(200).optional() }));
    return c.json(await deps.desks.createProject(input.name ?? "未命名项目"), 201);
  });

  app.delete("/api/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    await deps.sessions.forgetProject(projectId);
    const result = await deps.desks.deleteProject(projectId);
    await deps.files.removeProjectFiles(projectId, result.objectKeys);
    return c.body(null, 204);
  });
}
