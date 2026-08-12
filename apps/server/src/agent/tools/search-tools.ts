/**
 * search_tools：按意图查询桌面能力说明（纯推荐）。
 * 全部产品工具在 session 创建时已固定激活，本工具只帮助模型确认
 * 能力名称与用法，不改变任何可用工具集——这是缓存前缀稳定的前提。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";
import {
  SEARCH_TOOLS_NAME,
  enabledCatalog,
  searchToolMatches,
} from "./tool-activation.js";

const parameters = Type.Object({
  query: Type.String({
    description: "能力意图，例如「生图」「替换原图」「删除」「项目记忆」「查任务」「领域 skill」",
    minLength: 1,
    maxLength: 200,
  }),
});

export function createSearchToolsTool(_ctx: ToolContext) {
  return defineTool({
    name: SEARCH_TOOLS_NAME,
    label: "查询能力说明",
    description:
      "按意图查询桌面能力（生图、替换、删除、任务查询、项目记忆、领域 skill 等）的名称与用法说明。"
      + "全部工具始终可用，本工具仅提供说明；查询后直接调用对应业务工具完成操作。",
    promptSnippet: "search_tools — 按意图查询桌面能力说明（仅查询，不改变可用工具）",
    promptGuidelines: [
      "不确定该用哪个工具时用 search_tools 查说明；返回的能力都已可用，直接调用。",
      "query 用简短中文意图即可。",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const catalog = enabledCatalog();
      const matches = searchToolMatches(params.query, catalog);
      if (matches.length === 0) {
        const searchable = catalog.filter((e) => e.searchable).map((e) => `${e.name}（${e.summary}）`);
        return fail(
          `未匹配到能力说明。可尝试：生图、替换、删除、项目记忆、查任务、领域 skill。目录：${searchable.join("；")}`,
          { reason: "no_match", query: params.query },
        );
      }
      const summaries = new Map(catalog.map((e) => [e.name, e.summary]));
      const tools = matches.map((name) => ({ name, summary: summaries.get(name) ?? "" }));
      return ok(
        `以下能力已可用，直接调用：${tools.map((t) => `${t.name}（${t.summary}）`).join("；")}。`,
        {
          ok: true,
          query: params.query,
          matched: matches,
          tools,
        },
      );
    },
  });
}
