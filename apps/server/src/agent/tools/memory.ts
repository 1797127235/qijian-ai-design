import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";

const family = Type.Union([
  Type.Literal("project_truth"),
  Type.Literal("design_intent"),
  Type.Literal("design_decision"),
  Type.Literal("visual_system"),
  Type.Literal("decision_history"),
  Type.Literal("open_matter"),
  Type.Literal("project_procedure"),
  Type.Literal("generation_learning"),
]);

export function createInspectProjectMemoryTool(ctx: ToolContext) {
  return defineTool({
    name: "inspect_project_memory",
    label: "查看项目记忆",
    description: "查看当前项目记忆全文。",
    promptSnippet: "inspect_project_memory — 查看当前项目记忆",
    promptGuidelines: ["返回的是当前生效记忆；空表示尚未记录。"],
    parameters: Type.Object({}),
    executionMode: "parallel",
    async execute() {
      const service = ctx.deps.memory;
      if (!service) return fail("项目记忆服务未就绪");
      const state = await service.get(ctx.projectId);
      return ok(state.compiledContext || "（空）", {
        ok: true,
        revision: state.revision,
        entries: state.entries,
      });
    },
  });
}

export function createSearchProjectMemoryTool(ctx: ToolContext) {
  return defineTool({
    name: "search_project_memory",
    label: "搜索项目记忆",
    description: "在当前项目记忆条目中按关键词搜索。",
    promptSnippet: "search_project_memory — 搜索项目记忆条目",
    promptGuidelines: ["只搜当前生效条目，无独立历史库。"],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const service = ctx.deps.memory;
      if (!service) return fail("项目记忆服务未就绪");
      const hits = await service.search(ctx.projectId, params.query, params.limit ?? 10);
      return ok(
        hits.length
          ? hits.map((hit) => `${hit.family} ${hit.stableKey}: ${hit.summary}`).join("\n")
          : "没有找到相关项目记忆。",
        { ok: true, hits },
      );
    },
  });
}

export function createRecordMemoryTool(ctx: ToolContext) {
  return defineTool({
    name: "record_project_memory",
    label: "记录项目记忆",
    description: "直接写入或覆盖一条项目记忆（同 stable_key 后写覆盖）。成功即进入当前记忆与后续生图基线。",
    promptSnippet: "record_project_memory — 直接记录项目记忆（立即生效）",
    promptGuidelines: [
      "用稳定的 stable_key（如 materials.primary、lighting.temperature）。",
      "family 标明类型；summary 一句话，body 可写细节。",
      "方向 A/B 未选定时不要写进记忆。",
      "同 key 再次写入会覆盖。",
    ],
    parameters: Type.Object({
      stable_key: Type.String({ minLength: 1, maxLength: 300 }),
      family,
      summary: Type.String({ minLength: 1, maxLength: 2_000 }),
      body: Type.Optional(Type.String({ maxLength: 8_000 })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const service = ctx.deps.memory;
      if (!service) return fail("项目记忆服务未就绪");
      try {
        const key = params.stable_key.trim();
        const state = await service.write(ctx.projectId, {
          stableKey: key,
          family: params.family,
          summary: params.summary,
          body: params.body ?? params.summary,
        });
        return ok(`已记录 ${params.family}「${key}」，revision r${state.revision}。`, {
          ok: true,
          stable_key: key,
          family: params.family,
          revision: state.revision,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "记录项目记忆失败");
      }
    },
  });
}

export function createForgetMemoryTool(ctx: ToolContext) {
  return defineTool({
    name: "forget_project_memory",
    label: "删除项目记忆条目",
    description: "按 stable_key 删除一条当前项目记忆。",
    promptSnippet: "forget_project_memory — 删除一条记忆",
    promptGuidelines: ["只删明确不再成立的条目。"],
    parameters: Type.Object({
      stable_key: Type.String({ minLength: 1, maxLength: 300 }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const service = ctx.deps.memory;
      if (!service) return fail("项目记忆服务未就绪");
      try {
        const key = params.stable_key.trim();
        const { state, forgotten } = await service.forget(ctx.projectId, key);
        if (!forgotten) {
          return fail(`记忆「${key}」不存在或已删除`, {
            stable_key: key,
            revision: state.revision,
            forgotten: false,
          });
        }
        return ok(`已删除记忆「${key}」，revision r${state.revision}。`, {
          ok: true,
          stable_key: key,
          revision: state.revision,
          forgotten: true,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "删除项目记忆失败");
      }
    },
  });
}
