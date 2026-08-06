/** Agent 写桌：基于源物件生成 effect_image 并落源右侧（复用 CanvasGenerateService）。 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
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
      + "source_artifact_id 可省略，默认用当前选中；无选中且未传 id 时不要猜测，应请用户点选。",
    promptSnippet: "generate_from_desk — 从桌面源物件生成效果图并落桌",
    promptGuidelines: [
      "改图/出效果时调用 generate_from_desk。",
      "优先依赖本轮选中；仅当用户明确指定另一物件 id 时再传 source_artifact_id。",
      "工具返回 status=failed 时如实说明，不要编造成功。",
    ],
    parameters,
    executionMode: "sequential",
    // 第三个参数是 pi 在 session.abort() 时传入的 AbortSignal
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

      const clientOpId = `agent:${toolCallId || randomUUID()}`;
      try {
        const result = await ctx.deps.generate.generate({
          projectId: ctx.projectId,
          sourceArtifactId: sourceId,
          prompt,
          clientOpId,
          source: "agent_chat",
          createdBy: "agent",
          signal,
        });
        ctx.changed(result.artifact.id);

        if (result.status === "failed") {
          const stopped = /取消|停止|超时/.test(result.error ?? "");
          return fail(
            stopped
              ? `已停止生成。${result.error ?? ""}`.trim()
              : `生成失败：${result.error ?? "未知错误"}。已在桌面留下失败占位卡（${result.artifact.id}），可请用户重试或换描述。`,
            {
              artifact_id: result.artifact.id,
              source_artifact_id: sourceId,
              status: result.status,
              error: result.error,
            },
          );
        }

        return ok(
          `已生成效果图并落桌：artifact_id=${result.artifact.id}，源=${sourceId}，状态=${result.status}。`
          + `位置约 (${result.object.x}, ${result.object.y})，已与源物件连线。`,
          {
            artifact_id: result.artifact.id,
            source_artifact_id: sourceId,
            connection_id: result.connection.id,
            status: result.status,
            x: result.object.x,
            y: result.object.y,
          },
        );
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
