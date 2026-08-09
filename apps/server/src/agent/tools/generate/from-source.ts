/**
 * 用户要「再出一版 / 旁边对比 / 新方向」时用本工具，不要用 replace_on_desk。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { MAX_SELECTED_ARTIFACTS } from "../../../domain/selection-limits.js";
import { fail, type ToolContext } from "../shared.js";
import {
  resolveReferenceArtifactIds,
  resolveSourceArtifactId,
  runDeskGenerate,
} from "./shared/run-desk-generate.js";

const parameters = Type.Object({
  prompt: Type.String({
    description: "生成意图，例如「把地板换成这张材质图的样式，保留布局」",
    minLength: 1,
  }),
  source_artifact_id: Type.Optional(Type.String({
    description: "主源（场景）artifact id。多选时必须填写；单选时可省略。",
  })),
  reference_artifact_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "参考物件 id（材质/风格等，不含主源）。省略时用本轮选中减去主源。",
    maxItems: MAX_SELECTED_ARTIFACTS,
  })),
  model: Type.Optional(Type.String({
    description:
      "生图 model id（与面板可选列表一致）。用户点名引擎时必须传入；省略则平台默认；未知则失败。",
    minLength: 1,
    maxLength: 80,
  })),
});

export function createGenerateFromDeskTool(ctx: ToolContext) {
  return defineTool({
    name: "generate_from_desk",
    label: "桌面生图（旁落）",
    description:
      "根据桌面主源生成效果图，落在主源右侧新卡并连线。"
      + "用于「再出一版 / 旁边对比 / 新方向」。"
      + "若要在原卡上覆盖重生，请用 replace_on_desk，不要本工具。"
      + "多选时必须传 source_artifact_id；单选可省略。"
      + "立即返回 accepted+task_id；完成靠 [JOB_EVENT]。",
    promptSnippet: "generate_from_desk — 参考主源旁落新效果图",
    promptGuidelines: [
      "要在主源旁新建效果图时调用 generate_from_desk。",
      "用户要「重新生成/替换/覆盖原图」时改用 replace_on_desk，不要本工具。",
      "多选时必须传 source_artifact_id；reference_artifact_ids 为材质等参考。",
      "用户点名生图模型时必须传 model；未知 model 失败，禁止默默换引擎。",
      "未点名模型时不要传 model。",
      "status=accepted 只表示已开始；禁止说「已生成完成」。",
      "禁止循环 get_task；完成由 [JOB_EVENT] 通知。",
      "失败后禁止自动再次调用，除非用户明确要求重试。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const source = resolveSourceArtifactId(ctx, params.source_artifact_id);
      if (!source.ok) return fail(source.error);

      const refs = resolveReferenceArtifactIds(
        ctx,
        source.sourceId,
        params.reference_artifact_ids,
        params.reference_artifact_ids !== undefined,
      );
      if (!refs.ok) return fail(refs.error);

      return runDeskGenerate(ctx, {
        prompt: params.prompt,
        placement: {
          mode: "beside",
          sourceArtifactId: source.sourceId,
          referenceArtifactIds: refs.ids,
        },
        model: params.model,
        toolCallId,
        signal,
        toolName: "generate_from_desk",
      });
    },
  });
}
