/**
 * 项目路由：list / create / delete。
 *  - delete 顺序：先 forgetProject（释放所有 Agent session）→ 删 DB → 清磁盘文件
 *  - 不能反过来：先删 DB 再 forget 会让 session 写库报 FK 错
 */
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
  /** 列出所有项目（前端首页用）。 */
  app.get("/api/projects", async (c) => c.json(await deps.desks.listProjects()));

  /** 新建项目：name 可选，默认「未命名项目」。 */
  app.post("/api/projects", async (c) => {
    const input = await body(c.req.raw, z.object({ name: z.string().trim().min(1).max(200).optional() }));
    return c.json(await deps.desks.createProject(input.name ?? "未命名项目"), 201);
  });

  /** 删项目：级联清 chat / artifact / file / desk_state，再 rm 磁盘文件。 */
  app.delete("/api/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    await deps.sessions.forgetProject(projectId);
    const result = await deps.desks.deleteProject(projectId);
    await deps.files.removeProjectFiles(projectId, result.objectKeys);
    return c.body(null, 204);
  });
}
