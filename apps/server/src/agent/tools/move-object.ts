/** 写工具：经权限确认后，更新桌面物件的位置和旋转角度。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createMoveObjectTool({ projectId, deps, changed }: ToolContext) {
  return defineTool({
    name: "move_object",
    label: "移动物件",
    description: "移动或旋转桌面上的物件",
    parameters: Type.Object({
      artifact_id: Type.String(),
      x: Type.Number(),
      y: Type.Number(),
      rot: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params, signal) => {
      await deps.gate.check(projectId, "move_object", params, "移动桌面物件", signal);
      await deps.desks.moveObject(projectId, params.artifact_id, {
        x: params.x,
        y: params.y,
        ...(params.rot === undefined ? {} : { rot: params.rot }),
      });
      changed(params.artifact_id);
      return ok("物件已移动");
    },
  });
}
