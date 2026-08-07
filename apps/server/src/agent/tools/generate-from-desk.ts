/**
 * Agent 写桌：generate_from_desk 工具。
 *
 * 流程：
 *  1. 校验 prompt / source（默认用本轮选中）
 *  2. ownedCurrent 校验源属于当前项目
 *  3. jobs.run 异步：prepare 落 pending 卡 + 连线 → 后台 work 出图
 *  4. 立即返回 accepted 工具结果，不 await work
 *  5. 失败/取消时 fail() 返结构化错误，前端在状态栏能看到
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PreparedGenerate } from "../../services/canvas-generate-service.js";
import { fail, ok, type ToolContext } from "./shared.js";

const parameters = Type.Object({
  prompt: Type.String({
    description: "生成意图，例如「改成日式暖色木质客厅，保留现有布局」",
    minLength: 1,
  }),
  source_artifact_id: Type.Optional(Type.String({
    description: "源物件 artifact id。省略时使用本轮对话选中的桌面物件。",
  })),
});

export function createGenerateFromDeskTool(ctx: ToolContext) {
  return defineTool({
    name: "generate_from_desk",
    label: "桌面生图",
    description:
      "根据桌面源物件生成新效果图并落在源图右侧（自动连线）。"
      + "用户说改材质/风格/效果时调用。"
      + "source_artifact_id 可省略，默认用当前选中；无选中且未传 id 时不要猜测，应请用户点选。"
      + "工具立即返回 accepted+task_id（已开始），最终结果看桌面与 get_task，不要在 accepted 时声称已生成完成。",
    promptSnippet: "generate_from_desk — 从桌面源物件异步生成效果图并落桌",
    promptGuidelines: [
      "改图/出效果时调用 generate_from_desk。",
      "优先依赖本轮选中；仅当用户明确指定另一物件 id 时再传 source_artifact_id。",
      "返回 status=accepted 只表示已开始：告知用户看桌面进度，禁止说「已生成完成」。",
      "返回 status=failed 时如实说明同步失败原因。",
      "需要查进度时用 get_task(task_id)。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const prompt = params.prompt.trim();
      if (!prompt) return fail("prompt 不能为空");

      const selected = ctx.selectedArtifactIds()[0];
      const sourceId = (params.source_artifact_id?.trim() || selected || "").trim();
      if (!sourceId) {
        return fail("未指定源物件：请用户先在画布上点选一张图，或传入 source_artifact_id。");
      }

      try {
        await ctx.ownedCurrent(sourceId);
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
          input: { prompt, source_artifact_id: sourceId },
          prepare: async () => {
            prepared = await ctx.deps.generate.prepare({
              projectId: ctx.projectId,
              sourceArtifactId: sourceId,
              prompt,
              clientOpId,
              source: "agent_chat",
              createdBy: "agent",
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
              // failed 卡已写入；用 throw 让 runner 记 failed/cancelled
              throw err;
            }
            return {
              artifactId: result.artifact.id,
              result: {
                artifact_id: result.artifact.id,
                status: result.status,
                connection_id: result.connection.id,
              },
            };
          },
        });
        return ok(text, { ...details });
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || signal?.aborted)) {
          return fail("已停止生成", { source_artifact_id: sourceId, status: "failed" });
        }
        // prepare 失败会进这里；work 失败不进 execute（已 return accepted）
        const message = error instanceof Error ? error.message : "生成失败";
        return fail(message, { source_artifact_id: sourceId });
      }
    },
  });
}
