/**
 * Agent 生图工具包：旁落 + 原卡替换 + 文生图落桌。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolContext } from "../shared.js";
import { createGenerateFromDeskTool } from "./from-source.js";
import { createReplaceOnDeskTool } from "./replace-on-source.js";
import { createTextToDeskTool } from "./text-to-desk.js";

export function createGenerateTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createGenerateFromDeskTool(ctx),
    createReplaceOnDeskTool(ctx),
    createTextToDeskTool(ctx),
  ];
}

export { createGenerateFromDeskTool } from "./from-source.js";
export { createReplaceOnDeskTool } from "./replace-on-source.js";
export { createTextToDeskTool, TEXT_TO_DESK_TOOL_NAME } from "./text-to-desk.js";
export { DESK_GENERATE_JOB_KIND } from "./shared/run-desk-generate.js";
