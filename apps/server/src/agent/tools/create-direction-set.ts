/** 生成工具：在理解便签确认后，创建包含三个候选项的设计方向集。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createDirectionSetTool({ projectId, deps, place }: ToolContext) {
  return defineTool({
    name: "create_direction_set",
    label: "创建设计方向",
    description: "创建恰好三个可比较的设计方向，作为同一个方向集 Artifact",
    parameters: Type.Object({
      directions: Type.Array(Type.Object({
        id: Type.String(),
        title: Type.String(),
        concept: Type.String(),
        chips: Type.Array(Type.String()),
        tone: Type.Optional(Type.Union([
          Type.Literal("site"),
          Type.Literal("wood"),
          Type.Literal("cloth"),
          Type.Literal("green"),
        ])),
      }), { minItems: 3, maxItems: 3 }),
      x: Type.Number(),
      y: Type.Number(),
    }),
    execute: async (_id, params, signal) => {
      const snapshot = await deps.desks.snapshot(projectId);
      if (!snapshot.artifacts.some((artifact) => artifact.artifactType === "understanding_note" && artifact.status === "confirmed")) {
        throw new Error("请先确认至少一条 understanding_note");
      }
      if (new Set(params.directions.map((direction) => direction.id)).size !== 3) {
        throw new Error("三个方向必须使用不同的 id");
      }
      await deps.gate.check(projectId, "create_direction_set", params, "创建三张方向草图", signal);
      const result = await deps.artifacts.create(projectId, "design_directions", {
        payload: { directions: params.directions, selected_direction_id: null },
        createdBy: "agent",
      });
      await place(result.artifact.id, "direction_set", params.x, params.y);
      return ok("三个设计方向已创建", { artifactId: result.artifact.id });
    },
  });
}
