/**
 * 桌面路由：snapshot / viewport / 物件移动 / 物件删除 / 连线 / 面板生图。
 *  - 面板生图与 Agent 共用 Job 外壳（H8）：秒级 accepted + task_id，后台 complete
 *  - 物件删除实际是 artifact 删除（级联清版本 + 桌面布局 + 相关连线），见 artifact-service.deletePlaced
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { AgentJobRunner } from "../../agent/async-job/runner.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { CanvasGenerateService, PreparedGenerate } from "../../services/canvas-generate-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import { body } from "./shared.js";

export function registerDeskRoutes(app: Hono, deps: {
  desks: DeskStateService;
  artifacts: ArtifactService;
  generate?: CanvasGenerateService;
  jobs?: AgentJobRunner;
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
   * 面板生图（H8）：prepare + jobs.run → 秒级 accepted+task_id；complete 在后台。
   *  - prepare 失败抛 HttpError（无 job 行）
   *  - targetArtifactId：重试已有失败卡时传入，在原 effect_image 上 append 新版本
   */
  app.post("/api/projects/:id/generate-image", async (c) => {
    if (!deps.generate || !deps.jobs) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "生图服务未配置", retryable: false } }, 503);
    }
    const projectId = c.req.param("id");
    const input = await body(c.req.raw, z.object({
      prompt: z.string().max(4000).default(""),
      sourceArtifactId: z.string().uuid(),
      clientOpId: z.string().min(1).max(80),
      targetArtifactId: z.string().uuid().optional(),
      // 局部重绘：归一化选区（0–1）；任一边 < 2% 视为误触；x+w / y+h 可略越界，服务端 crop clamp
      region: z.object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(0.02).max(1),
        h: z.number().min(0.02).max(1),
      }).refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, {
        message: "选区超出图片边界",
      }).optional(),
      referenceFileId: z.string().uuid().optional(),
    }));

    let prepared: PreparedGenerate | undefined;
    const { details } = await deps.jobs.run({
      projectId,
      kind: "generate_from_desk",
      input: {
        origin: "canvas_panel",
        prompt: input.prompt,
        source_artifact_id: input.sourceArtifactId,
        target_artifact_id: input.targetArtifactId,
        client_op_id: input.clientOpId,
      },
      prepare: async () => {
        prepared = await deps.generate!.prepare({
          projectId,
          sourceArtifactId: input.sourceArtifactId,
          prompt: input.prompt,
          clientOpId: input.clientOpId,
          targetArtifactId: input.targetArtifactId,
          region: input.region,
          referenceFileId: input.referenceFileId,
          source: "canvas_panel",
          createdBy: "designer",
        });
        return { artifactId: prepared.pending.artifact.id };
      },
      work: async ({ signal }) => {
        if (!prepared) throw new Error("内部错误：prepare 未完成");
        const result = await deps.generate!.complete(prepared, signal);
        if (result.status === "failed") {
          const err = new Error(result.error ?? "生成失败");
          (err as Error & { name: string }).name = /取消|超时/.test(result.error ?? "")
            ? "AbortError"
            : "GenerateFailed";
          throw err;
        }
        return {
          artifactId: result.artifact.id,
          result: {
            artifact_id: result.artifact.id,
            status: result.status,
            connection_id: result.connection?.id,
          },
        };
      },
    });

    const pending = prepared!.pending;
    return c.json({
      status: "accepted" as const,
      async: true as const,
      task_id: details.task_id,
      artifact: pending.artifact,
      version: pending.version,
      object: pending.object,
      connection: pending.connection,
    }, 201);
  });
}
