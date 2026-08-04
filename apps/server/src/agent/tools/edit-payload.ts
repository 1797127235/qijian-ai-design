/** 写工具：修改草稿 Artifact 的载荷，并以新版本保存修改结果。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

const artifactTypeSchema = Type.Union([
  Type.Literal("design_brief"),
  Type.Literal("space_map"),
  Type.Literal("understanding_note"),
  Type.Literal("design_directions"),
  Type.Literal("effect_image"),
  Type.Literal("proposal_package"),
]);

export function createEditPayloadTool({ projectId, deps, ownedCurrent, changed }: ToolContext) {
  return defineTool({
    name: "edit_payload",
    label: "修改内容",
    description: "修改草稿 Artifact 内容并追加一个新版本",
    parameters: Type.Object({
      artifact_id: Type.String(),
      artifact_type: artifactTypeSchema,
      payload: Type.Record(Type.String(), Type.Unknown()),
      reason: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      await deps.gate.check(projectId, "edit_payload", params, "修改 Artifact 内容", signal);
      const current = await ownedCurrent(params.artifact_id);
      if (current.artifact.artifactType !== params.artifact_type) {
        throw new Error("artifact_type 与目标 Artifact 不一致");
      }
      if (current.version.status !== "draft") {
        throw new Error("已确认 Artifact 不能直接编辑；请先创建新的草稿版本");
      }
      const version = await deps.artifacts.append(params.artifact_id, {
        payload: params.payload,
        createdBy: "agent",
        changeReason: params.reason,
      });
      changed(params.artifact_id, true);
      return ok(`已追加版本 ${version.versionNo}`);
    },
  });
}
