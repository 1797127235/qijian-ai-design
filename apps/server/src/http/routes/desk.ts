/**
 * 桌面路由：snapshot / viewport / 物件移动 / 物件删除 / 连线 / 面板生图。
 *  - 面板生图是 HTTP 同步调用（小项目 UX 倾向），Agent 走 WS/工具路径
 *  - 物件删除实际是 artifact 删除（级联清版本 + 桌面布局 + 相关连线），见 artifact-service.deletePlaced
 */
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
  /** GET /desk 一次性返回 project + 全部 artifact + desk_state。 */
  app.get("/api/projects/:id/desk", async (c) => c.json(await deps.desks.snapshot(c.req.param("id"))));

  /** 视口持久化：缩放范围 0.1~4 防止 UI 错乱。 */
  app.patch("/api/projects/:id/desk", async (c) => {
    const input = await body(c.req.raw, z.object({
      viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) }),
    }));
    return c.json({ viewport: await deps.desks.setViewport(c.req.param("id"), input.viewport) });
  });

  /** 物件移动 / 旋转 / 缩放：只传要改的字段，refine 防全空。 */
  app.patch("/api/projects/:id/desk/objects/:artifactId", async (c) => {
    const patch = await body(c.req.raw, z.object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      rot: z.number().finite().optional(),
      w: z.number().positive().optional(),
    }).refine((value) => Object.keys(value).length > 0));
    return c.json(await deps.desks.moveObject(c.req.param("id"), c.req.param("artifactId"), patch));
  });

  /** 删物件（artifact + layout + 关联连线一并清）。 */
  app.delete("/api/projects/:id/desk/objects/:artifactId", async (c) => {
    return c.json(await deps.artifacts.deletePlaced(c.req.param("id"), c.req.param("artifactId")));
  });

  /** 创建连线。 */
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

  /** 删连线。 */
  app.delete("/api/projects/:id/desk/connections/:connectionId", async (c) => {
    return c.json(await deps.desks.deleteConnection(c.req.param("id"), c.req.param("connectionId")));
  });

  /**
   * 面板生图：HTTP 同步调用 prepare + complete。
   *  - 失败也返 200（业务失败 ≠ HTTP 失败），前端按 status 字段判断
   *  - targetArtifactId：重试已有失败卡时传入，在原 effect_image 上 append 新版本
   */
  app.post("/api/projects/:id/generate-image", async (c) => {
    if (!deps.generate) return c.json({ error: { code: "NOT_CONFIGURED", message: "生图服务未配置", retryable: false } }, 503);
    const input = await body(c.req.raw, z.object({
      prompt: z.string().max(4000).default(""),
      sourceArtifactId: z.string().uuid(),
      clientOpId: z.string().min(1).max(80),
      // 重试失败卡时传入，在原 effect_image 上 append，不新建
      targetArtifactId: z.string().uuid().optional(),
    }));
    const result = await deps.generate.generate({
      projectId: c.req.param("id"),
      sourceArtifactId: input.sourceArtifactId,
      prompt: input.prompt,
      clientOpId: input.clientOpId,
      targetArtifactId: input.targetArtifactId,
    });
    return c.json(result, result.status === "failed" ? 200 : 201);
  });
}
