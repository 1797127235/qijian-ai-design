/** 状态工具：确认当前 Artifact，并生成不可变的 confirmed 版本。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createConfirmArtifactTool({ projectId, deps, ownedCurrent, changed }: ToolContext) {
  return defineTool({
    name: "confirm_artifact",
    label: "确认内容",
    description: "确认当前 Artifact；会追加不可变的 confirmed 版本",
    parameters: Type.Object({ artifact_id: Type.String() }),
    execute: async (_id, params) => {
      await ownedCurrent(params.artifact_id);
      const version = await deps.artifacts.confirm(params.artifact_id, "agent");
      changed(params.artifact_id, true);
      return ok(`Artifact 已确认（版本 ${version.versionNo}）`);
    },
  });
}
