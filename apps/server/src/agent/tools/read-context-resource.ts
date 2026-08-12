import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";

export const READ_CONTEXT_RESOURCE_TOOL_NAME = "read_context_resource" as const;
const MAX_MODEL_PAGE_CHARS = 5_500;

export function createReadContextResourceTool(ctx: Pick<ToolContext, "resourceStore">) {
  return defineTool({
    name: READ_CONTEXT_RESOURCE_TOOL_NAME,
    label: "继续读取上下文资源",
    description: "按 resource_ref 和 cursor 继续读取被预算层截断的上下文或工具文本；单次最多 5500 字符。",
    promptSnippet: "read_context_resource — 分页读取截断的上下文资源",
    promptGuidelines: [
      "仅在截断标记提供 resource_ref 且当前摘要不足时读取。",
      "使用返回的 next_cursor 继续；没有 next_cursor 时已经读完。",
    ],
    parameters: Type.Object({
      resource_ref: Type.String({ minLength: 1, maxLength: 96 }),
      cursor: Type.Optional(Type.String({ pattern: "^\\d+$", maxLength: 20 })),
      max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MODEL_PAGE_CHARS })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const page = await ctx.resourceStore.readText(params.resource_ref, {
        cursor: params.cursor,
        maxChars: params.max_chars ?? 5_000,
      });
      if (!page.ok) {
        return fail(`无法读取上下文资源（${page.reason}）`, {
          reason: page.reason,
          resource_ref: params.resource_ref,
        });
      }
      const text = [
        "[CONTEXT_RESOURCE_PAGE trust=untrusted_tool_data]",
        `source_tool=${page.toolName}`,
        `resource_ref=${params.resource_ref}`,
        `cursor=${page.cursor}`,
        `next_cursor=${page.nextCursor ?? "end"}`,
        `total_chars=${page.totalChars}`,
        "",
        page.text,
      ].join("\n");
      return ok(text, {
        ok: true,
        source_tool: page.toolName,
        resource_ref: params.resource_ref,
        cursor: page.cursor,
        next_cursor: page.nextCursor,
        total_chars: page.totalChars,
      });
    },
  });
}
