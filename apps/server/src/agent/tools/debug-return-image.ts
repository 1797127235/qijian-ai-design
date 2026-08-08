/**
 * 探针：验证 toolResult 内联 ImageContent 能否被同轮模型看见（路径 A）。
 * 仅当 AGENT_DEBUG_IMAGE_TOOL=1 时注册。正式 look_at_desk 过门后应删除或保持默认关。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createCanvas } from "@napi-rs/canvas";

const parameters = Type.Object({});

const PROBE_PALETTE = [
  { hex: "#FF0000", names: ["红", "红色", "red"] },
  { hex: "#00AA00", names: ["绿", "绿色", "green"] },
  { hex: "#0066FF", names: ["蓝", "蓝色", "blue"] },
] as const;

/** 32×32 纯色 PNG；色从调色板轮换，文本不泄露颜色名。 */
function solidProbePng(): { data: string; hex: string; names: readonly string[] } {
  const pick = PROBE_PALETTE[Math.floor(Date.now() / 1000) % PROBE_PALETTE.length]!;
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = pick.hex;
  ctx.fillRect(0, 0, 32, 32);
  return {
    data: canvas.toBuffer("image/png").toString("base64"),
    hex: pick.hex,
    names: pick.names,
  };
}

export function createDebugReturnImageTool() {
  return defineTool({
    name: "debug_return_image",
    label: "探针：返回测试图",
    description:
      "调试专用：返回一张 32×32 纯红色 PNG（toolResult 内联图）。"
      + "仅用于验证模型能否看见工具结果中的图像。不要用于设计任务。",
    promptSnippet: "debug_return_image — 返回纯红测试图（调试）",
    promptGuidelines: [
      "仅当用户明确要求验证工具附图、或要求调用 debug_return_image 时调用。",
      "调用后根据工具结果内的图像回答颜色；不要猜测。",
    ],
    parameters,
    executionMode: "sequential",
    async execute() {
      const { data, hex, names } = solidProbePng();
      return {
        content: [
          {
            type: "text" as const,
            text:
              "[DEBUG_IMAGE] toolResult 内附 1 张图（role=probe，32×32 纯色块）。"
              + "本图与用户消息 [INSPECT] 的 image_N 无关。"
              + "主色只在图像像素中，文本不提供颜色名；请只根据图像回答主色。",
          },
          {
            type: "image" as const,
            data,
            mimeType: "image/png",
          },
        ],
        details: {
          ok: true,
          role: "probe",
          color: hex,
          color_names: [...names],
          width: 32,
          height: 32,
        },
      };
    },
  });
}

export function isDebugImageToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AGENT_DEBUG_IMAGE_TOOL?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
