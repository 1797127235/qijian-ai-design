/** 导出工具：将已确认内容和已采用效果图生成 PDF 与页面图片。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createExportPackageTool({ projectId, deps, changed }: ToolContext) {
  return defineTool({
    name: "export_package",
    label: "导出提案包",
    description: "把已确认内容和已采用效果图排版为 PDF 和图片",
    parameters: Type.Object({}),
    execute: async (_id, params, signal) => {
      await deps.gate.check(projectId, "export_package", params, "导出提案包", signal);
      const result = await deps.exports.export(projectId);
      changed(result.artifactId);
      return ok("提案包已导出", result);
    },
  });
}
