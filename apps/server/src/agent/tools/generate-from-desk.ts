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
      "改图/出效果时调用 generate_from_desk，不要声称未调用工具就已落桌。",
      "优先依赖本轮选中；仅当用户明确指定另一物件 id 时再传 source_artifact_id。",
      "工具返回 status=failed 时如实说明，不要编造成功。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const prompt = params.prompt.trim();
      if (!prompt) return fail("prompt 不能为空");

      const selected = ctx.selectedArtifactIds()[0];
      const sourceId = (params.source_artifact_id?.trim() || selected || "").trim();
      if (!sourceId) {
        return fail("未指定源物件：请用户先在画布上点选一张图，或传入 source_artifact_id。");
      }

      // 校验源在桌且属本项目
      try {
        await ctx.ownedCurrent(sourceId);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "源物件无效");
      }

      const clientOpId = `agent:${toolCallId || randomUUID()}`;
      try {
        // 同步跑完 pending→成功/失败；结束后推 object_changed 刷新画布
        const result = await ctx.deps.generate.generate({
          projectId: ctx.projectId,
          sourceArtifactId: sourceId,
          prompt,
          clientOpId,
          source: "agent_chat",
          createdBy: "agent",
        });
        ctx.changed(result.artifact.id);

        if (result.status === "failed") {
          return fail(
            `生成失败：${result.error ?? "未知错误"}。已在桌面留下失败占位卡（${result.artifact.id}），可请用户重试或换描述。`,
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
        const message = error instanceof Error ? error.message : "生成失败";
        return fail(message, { source_artifact_id: sourceId });
      }
    },
  });
}
