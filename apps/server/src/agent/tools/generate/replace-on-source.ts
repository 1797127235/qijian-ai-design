/**
 * replace_on_desk：在主源原卡上 append 新版本（替换画面，不新建卡）。
 * 用户要「重新生成 / 替换 / 覆盖 / 在原图上改」时用本工具。
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
    description: "重生意图，例如「纠正主卫位置，严格贴合原图二层平面」",
    minLength: 1,
  }),
  source_artifact_id: Type.Optional(Type.String({
    description: "要覆盖的那张卡 artifact id。多选时必须填写；单选时可省略。",
  })),
  reference_artifact_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "额外参考物件 id（不含被替换卡）。省略时用本轮选中减去主源。",
    maxItems: MAX_SELECTED_ARTIFACTS,
  })),
  model: Type.Optional(Type.String({
    description:
      "生图 model id（与面板可选列表一致）。用户点名引擎时必须传入；省略则平台默认；未知则失败。",
    minLength: 1,
    maxLength: 80,
  })),
});

export function createReplaceOnDeskTool(ctx: ToolContext) {
  return defineTool({
    name: "replace_on_desk",
    label: "桌面原卡替换",
    description:
      "在指定图片卡上重生并替换画面（append 新版本，不新建卡片）。"
      + "用于「重新生成 / 替换这张 / 覆盖 / 在原图上改」。"
      + "若要旁边再出一版对比，请用 generate_from_desk。"
      + "立即返回 accepted+task_id；完成靠 [JOB_EVENT]。",
    promptSnippet: "replace_on_desk — 原卡覆盖重生",
    promptGuidelines: [
      "用户要「重新生成/替换/覆盖/在原图上改」时调用 replace_on_desk。",
      "用户要「再出一版/旁边对比」时用 generate_from_desk，不要本工具。",
      "本工具保持串行：不要对同一卡并行多次 replace；并排多方向用 generate_from_desk。",
      "多选时必须传 source_artifact_id（要覆盖的那张）。",
      "用户点名生图模型时必须传 model；未知 model 失败，禁止默默换引擎。",
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
          mode: "replace",
          sourceArtifactId: source.sourceId,
          referenceArtifactIds: refs.ids,
        },
        model: params.model,
        toolCallId,
        signal,
        toolName: "replace_on_desk",
      });
    },
  });
}
