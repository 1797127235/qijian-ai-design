export type DeskObject =
  | {
      id: string;
      kind: "canvas_image";
      x: number;
      y: number;
      rot: number;
      /** 展示宽度；缺省 NODE_SIZE；高度按默认比例推算 */
      w?: number;
      status: "draft" | "confirmed";
      /** 与 Agent Survey 一致的桌面编号（A01…），按 desk_state.objects 顺序 */
      alias?: string;
      /** 人读展示名（display_name ?? 本地 fallback） */
      label?: string;
      /** 空占位卡无 url；上传或生成填回后存在 */
      url?: string;
      pending?: boolean;
      error?: string;
      /** 展示/审计用 composed prompt；重试优先用 userPrompt */
      prompt?: string;
      /** 用户原文（payload.user_prompt）；重试回传，避免叠前缀 */
      userPrompt?: string;
      /** 局部重绘选区（payload.region 透传，重试时回传） */
      region?: { x: number; y: number; w: number; h: number };
      /** 局部重绘参考图 fileId（payload.reference_file_id） */
      referenceFileId?: string;
    }
  | {
      id: string;
      kind: "effect_image";
      x: number;
      y: number;
      rot: number;
      /** 展示宽度；缺省 NODE_SIZE；高度按默认比例推算 */
      w?: number;
      status: "draft" | "confirmed";
      /** 与 Agent Survey 一致的桌面编号（A01…） */
      alias?: string;
      /** 人读展示名（display_name ?? 本地 fallback） */
      label?: string;
      url?: string;
      pending?: boolean;
      error?: string;
      prompt?: string;
      userPrompt?: string;
      region?: { x: number; y: number; w: number; h: number };
      referenceFileId?: string;
    };

export type DeskConnection = { id: string; from: string; to: string };

/** 过程时间线上的一步：思考段或工具调用，按真实发生顺序排列 */
export type ProcessStep =
  | { id: string; kind: "thinking"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      status: "running" | "succeeded" | "failed";
      /** 一行给人看的说明，如「生成完整俯视图」或失败原因 */
      label?: string;
    };

export type ProcessSnapshot = {
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  steps: ProcessStep[];
};

export type ChatItem =
  | { id: string; role: "user" | "agent"; text: string; attachments?: import("../lib/api").ChatAttachment[] }
  | { id: string; role: "process"; process: ProcessSnapshot };
