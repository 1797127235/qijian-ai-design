/**
 * Artifact 路由：创建 / 追加版本 / 回滚。
 *  - 创建时三种分支：restorePlaced（有 artifactId+layout，恢复删除）/ createPlaced（只 layout）/ create（都不传）
 *  - 版本是 append-only；rollback 仅移动 current_version_id 指针
 */
import type { Hono } from "hono";
import { z } from "zod";
import { artifactTypes } from "../../domain/types.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import { body } from "./shared.js";

/** artifactType 限定为白名单（新增类型要改 domain/types.ts + payload-rules.ts）。 */
const artifactTypeSchema = z.enum(artifactTypes);
/** 版本通用 schema：payload / inputRefs / status / createdBy。 */
const versionSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  inputRefs: z.array(z.unknown()).optional(),
  status: z.enum(["draft", "confirmed"]).optional(),
  createdBy: z.enum(["designer", "agent"]).default("designer"),
  changeReason: z.string().max(500).optional(),
});

export function registerArtifactRoutes(app: Hono, deps: { artifacts: ArtifactService }) {
  app.post("/api/projects/:id/artifacts", async (c) => {
    const input = await body(c.req.raw, z.object({
      artifactType: artifactTypeSchema,
      ...versionSchema.shape,
      artifactId: z.string().uuid().optional(),
      clientOpId: z.string().min(1).max(64).optional(),
      layout: z.object({ kind: z.string(), x: z.number(), y: z.number(), rot: z.number().default(0), w: z.number().optional() }).optional(),
    }));
    const projectId = c.req.param("id");
    // 三态分支：restore（带 id+layout 复活已删）/ createPlaced（带 layout 新建+落桌）/ create（都不传）
    if (input.artifactId && input.layout) {
      const { artifactId, clientOpId: _clientOpId, layout, artifactType, ...version } = input;
      return c.json(await deps.artifacts.restorePlaced(projectId, { artifactId, artifactType, ...version, layout }), 201);
    }
    if (input.layout) {
      const { layout, artifactType, clientOpId, artifactId: _artifactId, ...version } = input;
      return c.json(await deps.artifacts.createPlaced(projectId, artifactType, version, layout, clientOpId), 201);
    }
    return c.json(await deps.artifacts.create(projectId, input.artifactType, input), 201);
  });

  /** 追加版本：current_version_id 指针前移。 */
  app.post("/api/artifacts/:id/versions", async (c) => {
    const input = await body(c.req.raw, versionSchema);
    return c.json(await deps.artifacts.append(c.req.param("id"), input), 201);
  });

  /** 回滚：不传 versionId 默认回到上一版。 */
  app.post("/api/artifacts/:id/rollback", async (c) => {
    const input = await body(c.req.raw, z.object({ versionId: z.string().uuid().optional() }));
    return c.json(await deps.artifacts.rollback(c.req.param("id"), input.versionId));
  });
}
