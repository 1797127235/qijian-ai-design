/** 写工具：将效果图变体标记为采用，并追加不可变 Artifact 版本。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createAdoptVariantTool({ projectId, deps, ownedCurrent, changed }: ToolContext) {
  return defineTool({
    name: "adopt_variant",
    label: "采用变体",
    description: "采用一个效果图变体",
    parameters: Type.Object({ artifact_id: Type.String() }),
    execute: async (_id, params, signal) => {
      await deps.gate.check(projectId, "adopt_variant", params, "采用效果图变体", signal);
      const current = await ownedCurrent(params.artifact_id);
      if (current.artifact.artifactType !== "effect_image") {
        throw new Error("只能采用 effect_image Artifact");
      }
      await deps.artifacts.append(params.artifact_id, {
        payload: { ...current.version.payload, adopted: true },
        inputRefs: current.version.inputRefs,
        createdBy: "agent",
        changeReason: "adopt_variant",
      });
      changed(params.artifact_id, true);
      return ok("变体已采用");
    },
  });
}
