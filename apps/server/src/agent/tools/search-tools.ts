/**
 * search_tools：发现并激活已注册桌面工具（窄 base 发现式加载）。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";
import {
  SEARCH_TOOLS_NAME,
  applyToolActivation,
  enabledCatalog,
  mergeActivation,
  searchToolMatches,
} from "./tool-activation.js";

const parameters = Type.Object({
  query: Type.String({
    description: "能力意图，例如「生图」「替换原图」「删除」「项目记忆」「查任务」",
    minLength: 1,
    maxLength: 200,
  }),
});

export function createSearchToolsTool(ctx: ToolContext) {
  return defineTool({
    name: SEARCH_TOOLS_NAME,
    label: "搜索并激活工具",
    description:
      "当需要当前未激活的能力（生图、替换、删除、任务查询、项目记忆等）时调用。"
      + "根据意图匹配已注册工具并激活；成功后本轮即可调用新工具。"
      + "不要用本工具代替实际操作；激活后请继续调用对应业务工具。",
    promptSnippet: "search_tools — 按意图发现并激活桌面工具",
    promptGuidelines: [
      "缺少生图/替换/删除/记忆/get_task 等能力时先 search_tools。",
      "query 用简短中文意图即可。",
      "激活后立即调用业务工具；不要只搜索不操作。",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const session = ctx.agentSession?.();
      const identity = ctx.identityPrompt?.();
      if (!session || !identity) {
        return fail("工具激活服务未就绪", { reason: "no_session" });
      }
      const catalog = enabledCatalog();
      const matches = searchToolMatches(params.query, catalog);
      if (matches.length === 0) {
        const searchable = catalog.filter((e) => e.searchable).map((e) => `${e.name}（${e.summary}）`);
        return fail(
          `未匹配到工具。可尝试：生图、替换、删除、项目记忆、查任务。目录：${searchable.join("；")}`,
          { reason: "no_match", query: params.query },
        );
      }
      const current = session.getActiveToolNames();
      // wake 硬名单：若当前不含 search_tools，说明处于 wake，拒绝扩大能力
      if (!current.includes(SEARCH_TOOLS_NAME)) {
        return fail("当前为任务回注轮次，不能搜索或激活生图/删除等工具；请向用户说明结果，等待用户明确要求后再操作。", {
          reason: "wake_locked",
          query: params.query,
        });
      }
      const next = mergeActivation(current, matches);
      const active = applyToolActivation(session, next, identity);
      const opened = matches.filter((name) => active.includes(name));
      const failed = matches.filter((name) => !active.includes(name));
      // 全部失败：硬错误，禁止空转重试
      if (opened.length === 0) {
        return fail(
          `工具已匹配但未能激活：${failed.join(", ")}。请勿重复 search_tools；向用户说明当前无法调用该能力。`,
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
      const partial = failed.length > 0
        ? `（未激活：${failed.join(", ")}，勿为它们重复 search）`
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
