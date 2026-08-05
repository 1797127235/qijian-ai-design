/** 写工具：将效果图变体标记为弃用，并追加不可变 Artifact 版本。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createDiscardVariantTool({ projectId, deps, ownedCurrent, changed }: ToolContext) {
  return defineTool({
    name: "discard_variant",
    label: "弃用变体",
    description: "弃用一个效果图变体",
    parameters: Type.Object({ artifact_id: Type.String() }),
    execute: async (_id, params) => {
      const current = await ownedCurrent(params.artifact_id);
      if (current.artifact.artifactType !== "effect_image") {
        throw new Error("只能弃用 effect_image Artifact");
      }
      await deps.artifacts.append(params.artifact_id, {
        payload: { ...current.version.payload, adopted: false },
        inputRefs: current.version.inputRefs,
        createdBy: "agent",
        changeReason: "discard_variant",
      });
      changed(params.artifact_id, true);
      return ok("变体已弃用");
    },
  });
}
