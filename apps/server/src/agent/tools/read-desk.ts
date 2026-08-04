/** 只读工具：返回项目当前的 Artifact、桌面布局和视口快照。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createReadDeskTool({ projectId, deps }: ToolContext) {
  return defineTool({
    name: "read_desk",
    label: "读取桌面",
    description: "读取整张桌面的当前 Artifact 版本、状态和位置",
    parameters: Type.Object({}),
    execute: async () => ok(JSON.stringify(await deps.desks.snapshot(projectId))),
  });
}
