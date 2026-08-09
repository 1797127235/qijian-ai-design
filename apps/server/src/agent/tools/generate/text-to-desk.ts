/**
 * text_to_image_on_desk：无主源文生图落桌（spawn 新卡）。
 * 空桌 / 纯文字起一张图时用；有主源改图请用 generate_from_desk / replace_on_desk。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { MAX_SELECTED_ARTIFACTS } from "../../../domain/selection-limits.js";
import { fail, type ToolContext } from "../shared.js";
import {
  resolveSpawnReferenceArtifactIds,
  runDeskGenerate,
} from "./shared/run-desk-generate.js";

export const TEXT_TO_DESK_TOOL_NAME = "text_to_image_on_desk" as const;

const parameters = Type.Object({
  prompt: Type.String({
    description: "文生图意图，例如「现代日式客厅，暖木色，下午自然光」",
    minLength: 1,
  }),
  reference_artifact_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "可选参考物件 id（材质/氛围）。不要传主源场景图当「要改的那张」。",
    maxItems: MAX_SELECTED_ARTIFACTS,
  })),
  model: Type.Optional(Type.String({
    description:
      "生图 model id（与面板可选列表一致）。用户点名引擎时必须传入；省略则平台默认；未知则失败。",
    minLength: 1,
    maxLength: 80,
  })),
  x: Type.Optional(Type.Number({
    description: "可选世界坐标 x；与 y 同时给出时作落点偏好（重叠仍会平移找空位）。",
  })),
  y: Type.Optional(Type.Number({
    description: "可选世界坐标 y；与 x 同时给出时作落点偏好。",
  })),
});

export function createTextToDeskTool(ctx: ToolContext) {
  return defineTool({
    name: TEXT_TO_DESK_TOOL_NAME,
    label: "文生图落桌",
    description:
      "无主源、仅凭文字（可选参考图）在桌面新建一张效果图。"
      + "用于空桌起图、纯文字新方向。"
      + "有主源要「再出一版」用 generate_from_desk；要「覆盖原卡」用 replace_on_desk；不要本工具。"
      + "落点：视口中心起找空位，不盖已有卡；可选 x/y 偏好。"
      + "立即返回 accepted+task_id；完成靠 [JOB_EVENT]。",
    promptSnippet: "text_to_image_on_desk — 无主源文生图落桌",
    promptGuidelines: [
      "空桌或用户只要文字起一张新图时调用 text_to_image_on_desk。",
      "桌上已有主源要改/衍生时用 generate_from_desk 或 replace_on_desk，不要本工具。",
      "不要传 source_artifact_id；本工具不能原卡替换。",
      "用户点名生图模型时必须传 model；未知 model 失败，禁止默默换引擎。",
      "status=accepted 只表示已开始；禁止说「已生成完成」。",
      "禁止循环 get_task；完成由 [JOB_EVENT] 通知。",
      "失败后禁止自动再次调用，除非用户明确要求重试。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const refs = resolveSpawnReferenceArtifactIds(params.reference_artifact_ids);
      if (!refs.ok) return fail(refs.error);

      const hasX = typeof params.x === "number" && Number.isFinite(params.x);
      const hasY = typeof params.y === "number" && Number.isFinite(params.y);
      if (hasX !== hasY) {
        return fail("x 与 y 须同时提供，或都不提供");
      }

      return runDeskGenerate(ctx, {
        prompt: params.prompt,
        placement: {
          mode: "spawn",
          referenceArtifactIds: refs.ids,
          ...(hasX && hasY ? { x: params.x, y: params.y } : {}),
        },
        model: params.model,
        toolCallId,
        signal,
        toolName: TEXT_TO_DESK_TOOL_NAME,
      });
    },
  });
}
