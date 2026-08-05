/** 写工具：将已有 Artifact 放入当前项目桌面。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createPlaceObjectTool({ projectId, deps, place }: ToolContext) {
  return defineTool({
    name: "place_object",
    label: "摆放物件",
    description: "把一个已有 Artifact 摆到桌面上",
    parameters: Type.Object({
      artifact_id: Type.String(),
      kind: Type.String(),
      x: Type.Number(),
      y: Type.Number(),
      rot: Type.Optional(Type.Number()),
      w: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params) => {
      await place(params.artifact_id, params.kind, params.x, params.y, params.rot, params.w);
      return ok("物件已摆放");
    },
  });
}
