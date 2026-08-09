/**
 * Agent 写桌：generate_from_desk 工具。
 *
 * 流程：
 *  1. 校验 prompt / 主源（多选时必须 source_artifact_id 或恰好单选）
 *  2. 可选 model：与面板同一 allowlist；未知则 fail，禁止静默主站默认（E2）
 *  3. ownedCurrent 校验源属于当前项目
 *  4. jobs.run 异步：prepare 落 pending 卡 + 多 from 连线 → 后台 work 出图
 *  5. 立即返回 accepted 工具结果，不 await work
 *  6. 失败/取消时 fail() 返结构化错误
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { MAX_SELECTED_ARTIFACTS } from "../../domain/selection-limits.js";
import type { PreparedGenerate } from "../../services/canvas-generate-service.js";
import { matchImageModelId } from "../../services/image-providers.js";
import { fail, ok, type ToolContext } from "./shared.js";

const parameters = Type.Object({
  prompt: Type.String({
    description: "生成意图，例如「把地板换成这张材质图的样式，保留布局」",
    minLength: 1,
  }),
  source_artifact_id: Type.Optional(Type.String({
    description: "主源（要改的那张场景）artifact id。多选时必须填写；单选时可省略。",
  })),
  reference_artifact_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "参考物件 id 列表（材质/风格参考等，不含主源）。省略时用本轮选中减去主源。",
    maxItems: MAX_SELECTED_ARTIFACTS,
  })),
  model: Type.Optional(Type.String({
    description:
      "生图 model id（与面板可选列表一致，如 gpt-image-2）。"
      + "用户点名引擎时必须传入；省略则用平台默认。"
      + "不在列表中时工具失败，禁止改用默认引擎。",
    minLength: 1,
    maxLength: 80,
  })),
});

export function createGenerateFromDeskTool(ctx: ToolContext) {
  return defineTool({
    name: "generate_from_desk",
    label: "桌面生图",
    description:
      "根据桌面源物件生成新效果图并落在主源右侧（自动连线）。"
      + "用户说改材质/风格/效果时调用。"
      + "多选时：必须传 source_artifact_id 指定主图（场景），其余为参考；"
      + "单选时可省略 source，默认当前选中。"
      + "用户指定生图模型时传 model（与面板同一 allowlist）；未知 model 会失败，不要假装已用该引擎。"
      + "立即返回 accepted+task_id；完成后系统推送 [JOB_EVENT]，不要循环 get_task。",
    promptSnippet: "generate_from_desk — 异步生图落桌（task_id；完成靠 JOB_EVENT）",
    promptGuidelines: [
      "改图/出效果时调用 generate_from_desk。",
      "多选改图时必须传 source_artifact_id（要改的那张场景）；reference_artifact_ids 为材质等参考。",
      "仅单选时可省略 source_artifact_id，默认用选中。",
      "用户点名生图模型（如 gpt image2 / gpt-image-2）时必须传 model；失败则如实说明可用列表，禁止默默用默认引擎开干。",
      "未点名模型时不要传 model（走平台默认）。",
      "返回 status=accepted 只表示已开始：告知用户看桌面进度，禁止说「已生成完成」。",
      "禁止循环 get_task 等待；完成由 [JOB_EVENT] 系统事件通知。",
      "收到失败 JOB_EVENT 后禁止自动再次 generate_from_desk，除非用户明确要求重试。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const prompt = params.prompt.trim();
      if (!prompt) return fail("prompt 不能为空");

      const selected = ctx.selectedArtifactIds().filter(Boolean);
      const explicitSource = params.source_artifact_id?.trim() || "";
      let sourceId = explicitSource;
      if (!sourceId) {
        if (selected.length === 1) sourceId = selected[0];
        else if (selected.length > 1) {
          return fail("多选时请指定主图 source_artifact_id（要改的那张场景图）。");
        }
      }
      if (!sourceId) {
        return fail("未指定源物件：请用户先在画布上点选一张图，或传入 source_artifact_id。");
      }

      // 显式 reference_artifact_ids 替换选中派生列表；省略参数时才用选中减去主源
      const hasExplicitRefs = params.reference_artifact_ids !== undefined;
      const refsFromParams = (params.reference_artifact_ids ?? [])
        .map((id) => id.trim())
        .filter(Boolean);
      const refsFromSelection = selected.filter((id) => id !== sourceId);
      const referenceArtifactIds = [...new Set(
        hasExplicitRefs ? refsFromParams : refsFromSelection,
      )]
        .filter((id) => id !== sourceId)
        .slice(0, MAX_SELECTED_ARTIFACTS);
      if (hasExplicitRefs && refsFromParams.length > MAX_SELECTED_ARTIFACTS) {
        return fail(`参考物件不能超过 ${MAX_SELECTED_ARTIFACTS} 个`);
      }

      const knownModels = ctx.deps.imageModelOptions ?? [];
      const modelMatch = matchImageModelId(params.model, knownModels);
      if (modelMatch === null) {
        const requested = params.model?.trim() || "";
        const available = knownModels.length > 0
          ? knownModels.join(", ")
          : "（当前未配置任何生图 model）";
        return fail(
          `未知生图 model：${requested}。可用：${available}。请改用列表中的 id，勿静默使用默认引擎。`,
          {
            reason: "unknown_model",
            model: requested,
            available_models: knownModels,
          },
        );
      }
      const imageModel = modelMatch;

      try {
        await ctx.ownedCurrent(sourceId);
        for (const refId of referenceArtifactIds) {
          await ctx.ownedCurrent(refId);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : "源物件无效");
      }

      if (signal?.aborted) return fail("已停止", { source_artifact_id: sourceId, status: "failed" });

      const jobs = ctx.deps.jobs;
      const session = ctx.session;
      if (!jobs || !session) {
        return fail("异步任务服务未就绪");
      }

      const clientOpId = `agent:${toolCallId || randomUUID()}`;
      let prepared: PreparedGenerate | undefined;

      try {
        const { text, details } = await jobs.run({
          projectId: ctx.projectId,
          threadId: session.threadId,
          runId: session.runId(),
          toolCallId,
          kind: "generate_from_desk",
          input: {
            origin: "agent_chat",
            prompt,
            source_artifact_id: sourceId,
            reference_artifact_ids: referenceArtifactIds,
            client_op_id: clientOpId,
            ...(imageModel ? { model: imageModel } : {}),
          },
          prepare: async () => {
            prepared = await ctx.deps.generate.prepare({
              projectId: ctx.projectId,
              sourceArtifactId: sourceId,
              prompt,
              clientOpId,
              referenceArtifactIds,
              source: "agent_chat",
              createdBy: "agent",
              ...(imageModel ? { model: imageModel } : {}),
            });
            return { artifactId: prepared.pending.artifact.id };
          },
          work: async ({ signal: jobSignal }) => {
            if (!prepared) throw new Error("内部错误：prepare 未完成");
            const result = await ctx.deps.generate.complete(prepared, jobSignal);
            if (result.status === "failed") {
              const err = new Error(result.error ?? "生成失败");
              (err as Error & { name: string }).name = /取消|超时/.test(result.error ?? "")
                ? "AbortError"
                : "GenerateFailed";
              throw err;
            }
            return {
              artifactId: result.artifact.id,
              result: {
                artifact_id: result.artifact.id,
                status: result.status,
                connection_id: result.connection?.id,
              },
            };
          },
        });
        return ok(text, { ...details });
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || signal?.aborted)) {
          return fail("已停止生成", { source_artifact_id: sourceId, status: "failed" });
        }
        const message = error instanceof Error ? error.message : "生成失败";
        return fail(message, { source_artifact_id: sourceId });
      }
    },
  });
}
