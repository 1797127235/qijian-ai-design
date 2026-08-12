/**
 * search_tools：发现并激活已注册桌面工具（窄 base 发现式加载）。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";
import {
  SEARCH_TOOLS_NAME,
  activateTools,
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

export function createSearchToolsTool(ctx: ToolContext) {
  return defineTool({
    name: SEARCH_TOOLS_NAME,
    label: "搜索并激活工具",
    description:
      "当需要当前未激活的能力（生图、替换、删除、任务查询、项目记忆、领域 skill 等）时调用。"
      + "根据意图匹配已注册工具并激活；成功后本轮即可调用新工具。"
      + "本工具负责发现与激活；激活后继续调用对应业务工具完成操作。",
    promptSnippet: "search_tools — 按意图发现并激活桌面工具",
    promptGuidelines: [
      "缺少生图/替换/删除/记忆/get_task/search_skills 等能力时先 search_tools。",
      "query 用简短中文意图即可。",
      "激活后立即调用业务工具完成用户请求。",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const session = ctx.agentSession?.();
      const toolState = ctx.toolState?.();
      if (!session || !toolState) {
        return fail("工具激活服务未就绪", { reason: "no_session" });
      }
      const catalog = enabledCatalog();
      const matches = searchToolMatches(params.query, catalog);
      if (matches.length === 0) {
        const searchable = catalog.filter((e) => e.searchable).map((e) => `${e.name}（${e.summary}）`);
        return fail(
          `未匹配到工具。可尝试：生图、替换、删除、项目记忆、查任务、领域 skill。目录：${searchable.join("；")}`,
          { reason: "no_match", query: params.query },
        );
      }
      const current = session.getActiveToolNames();
      const next = toolState.orderAdditions(current, matches);
      const active = activateTools(session, next);
      toolState.recordActiveSet(active);
      const opened = matches.filter((name) => active.includes(name));
      const failed = matches.filter((name) => !active.includes(name));
      // 全部失败：返回明确错误，引导模型转为告知能力不可用
      if (opened.length === 0) {
        return fail(
          `工具已匹配但未能激活：${failed.join(", ")}。请直接向用户说明当前无法调用该能力。`,
          {
            reason: "activation_failed",
            query: params.query,
            matched: matches,
            activated: opened,
            failed,
            active_tools: active,
          },
        );
      }
      toolState.recordDiscovery(opened);
      const partial = failed.length > 0
        ? `（未激活：${failed.join(", ")}；请使用已激活项）`
        : "";
      return ok(
        `已激活：${opened.join(", ")}${partial}。请立即使用这些工具完成用户请求。`,
        {
          ok: true,
          query: params.query,
          matched: matches,
          activated: opened,
          failed,
          active_tools: active,
        },
      );
    },
  });
}
