/**
 * Agent 过程时间线的纯函数。
 *
 * 为什么单独抽：
 *  - useChatSession 的 WS 回调曾堆满 agent_start/tool/settled 分支，难测难改
 *  - 这里只描述「事件 → process 草稿 + 对 UI 的意图」，副作用由 hook 的 commitProcessResult 执行
 */
import type { ChatItem, ProcessSnapshot, ProcessStep } from "../desk/types";
import {
  emptyProcess,
  isToolBusinessFailure,
  toolStepLabel,
} from "../desk/chat/process-summary";
import { nextId } from "./ids";

/** 进行中 process 在 chatItems 里的固定 id；finalize 后换成唯一 id 以便历史保留多段。 */
export const PROCESS_ITEM_ID = "agent-process-live";

/** 就地更新「当前这一轮」过程卡（同 id 替换）。 */
export function upsertProcessItem(items: ChatItem[], process: ProcessSnapshot): ChatItem[] {
  const next: ChatItem = { id: PROCESS_ITEM_ID, role: "process", process };
  return [...items.filter((it) => it.id !== PROCESS_ITEM_ID), next];
}

/** 本轮结束：冻结快照、换新 id，避免下一轮 agent_start 覆盖历史过程卡。 */
export function finalizeProcessItem(items: ChatItem[], process: ProcessSnapshot): ChatItem[] {
  const finalized: ChatItem = {
    id: `process-${nextId()}`,
    role: "process",
    process: { ...process, steps: process.steps.map((s) => ({ ...s })) },
  };
  return [...items.filter((it) => it.id !== PROCESS_ITEM_ID), finalized];
}

/** agent_event 内层载荷（只取 process 时间线需要的字段）。 */
export type AgentInnerEvent = {
  type?: string;
  threadId?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  assistantMessageEvent?: { type?: string; delta?: string };
};

/** hook 根据此结果改 state，避免在纯函数里 setState。 */
export type ProcessApplyResult = {
  process: ProcessSnapshot | null;
  /** upsert=进行中卡；finalize=本轮结束落历史；clear=去掉 live 卡 */
  chatItems?: "upsert" | "finalize" | "clear";
  busy?: boolean;
  /** 流式正文 delta；undefined 表示不动 streamBuf */
  streamDelta?: string;
  clearStream?: boolean;
};

/**
 * 应用一条 agent_event 内层事件。
 * 约定：整轮 status 在 tool 结束后仍保持 running，直到 agent_settled，
 * 否则标题会过早变成「思考了 Ns」而模型还在回正文。
 */
export function applyAgentInnerEvent(
  process: ProcessSnapshot | null,
  inner: AgentInnerEvent,
  now = Date.now,
  newId: () => string = nextId,
): ProcessApplyResult {
  if (inner.type === "message_update" && inner.assistantMessageEvent) {
    const ame = inner.assistantMessageEvent;
    if (ame.type === "text_delta" && ame.delta) {
      return { process, streamDelta: ame.delta };
    }
    if (ame.type === "thinking_delta" && ame.delta) {
      const draft = process ?? emptyProcess();
      if (!Number.isFinite(draft.startedAt)) draft.startedAt = now();
      draft.status = "running";
      const last = draft.steps[draft.steps.length - 1];
      if (last?.kind === "thinking") last.text += ame.delta;
      else draft.steps.push({ id: newId(), kind: "thinking", text: ame.delta });
      return { process: draft, chatItems: "upsert" };
    }
    return { process };
  }

  if (inner.type === "agent_start") {
    return { process: emptyProcess(), chatItems: "upsert", busy: true };
  }

  if (inner.type === "agent_settled") {
    if (!process) return { process: null, busy: false };
    const failed = process.steps.some((s) => s.kind === "tool" && s.status === "failed");
    process.status = failed ? "failed" : "done";
    process.endedAt = now();
    return { process, chatItems: "finalize", busy: false };
  }

  if (inner.type === "tool_execution_start" && inner.toolName) {
    const toolCallId = inner.toolCallId ?? `${inner.toolName}-${now()}`;
    const step: ProcessStep = {
      id: toolCallId,
      kind: "tool",
      name: inner.toolName,
      status: "running",
      label: toolStepLabel(inner.args, undefined, false),
    };
    const draft = process ?? emptyProcess();
    if (!Number.isFinite(draft.startedAt)) draft.startedAt = now();
    draft.status = "running";
    const idx = draft.steps.findIndex((s) => s.id === toolCallId);
    if (idx >= 0) draft.steps[idx] = step;
    else draft.steps.push(step);
    return { process: draft, chatItems: "upsert" };
  }

  if (inner.type === "tool_execution_end") {
    const toolCallId = inner.toolCallId;
    const failed = isToolBusinessFailure(inner.result, inner.isError);
    const draft = process ?? emptyProcess();
    if (!Number.isFinite(draft.startedAt)) draft.startedAt = now();
    draft.status = "running";
    const tools = draft.steps.filter((s): s is Extract<ProcessStep, { kind: "tool" }> => s.kind === "tool");
    const step = toolCallId
      ? tools.find((t) => t.id === toolCallId)
      : tools.find((t) => t.status === "running");
    const label = toolStepLabel(undefined, inner.result, failed);
    if (!step) {
      draft.steps.push({
        id: toolCallId ?? `tool-end-${now()}`,
        kind: "tool",
        name: inner.toolName ?? "tool",
        status: failed ? "failed" : "succeeded",
        label,
      });
    } else {
      step.status = failed ? "failed" : "succeeded";
      if (label) step.label = label;
    }
    return { process: draft, chatItems: "upsert" };
  }

  return { process };
}

/** agent_stopped：把进行中 process 标失败并 finalize。 */
export function settleProcessStopped(process: ProcessSnapshot | null, now = Date.now): ProcessApplyResult {
  if (!process) return { process: null, busy: false };
  process.status = "failed";
  process.endedAt = now();
  for (const t of process.steps) {
    if (t.kind === "tool" && t.status === "running") {
      t.status = "failed";
      t.label = t.label ?? "已停止";
    }
  }
  return { process, chatItems: "finalize", busy: false };
}

/** error 事件：失败 process + 错误文案消息。 */
export function settleProcessError(
  items: ChatItem[],
  process: ProcessSnapshot | null,
  message: string,
): { items: ChatItem[]; process: null } {
  const errorItem: ChatItem = { id: nextId(), role: "agent", text: `出错了：${message}` };
  if (process) {
    process.status = "failed";
    return { items: [...finalizeProcessItem(items, process), errorItem], process: null };
  }
  return {
    items: [...items.filter((item) => item.id !== PROCESS_ITEM_ID), errorItem],
    process: null,
  };
}
