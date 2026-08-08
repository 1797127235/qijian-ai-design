import { describe, expect, it } from "vitest";
import {
  PROCESS_ITEM_ID,
  applyAgentInnerEvent,
  finalizeProcessItem,
  settleProcessError,
  settleProcessStopped,
  upsertProcessItem,
} from "./chatProcess";
import { emptyProcess } from "../desk/chat/process-summary";
import type { ChatItem } from "../desk/types";

describe("chatProcess", () => {
  it("upsert / finalize process item ids", () => {
    const process = emptyProcess();
    const items = upsertProcessItem([], process);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: PROCESS_ITEM_ID, role: "process" });
    const finalized = finalizeProcessItem(items, process);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].id).not.toBe(PROCESS_ITEM_ID);
  });

  it("agent_start 开启 process 并 busy", () => {
    const r = applyAgentInnerEvent(null, { type: "agent_start" });
    expect(r.busy).toBe(true);
    expect(r.chatItems).toBe("upsert");
    expect(r.process?.status).toBe("running");
  });

  it("thinking_delta 追加思考段", () => {
    const start = applyAgentInnerEvent(null, { type: "agent_start" });
    const r = applyAgentInnerEvent(start.process, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "先看" },
    });
    expect(r.chatItems).toBe("upsert");
    expect(r.process?.steps).toEqual([
      expect.objectContaining({ kind: "thinking", text: "先看" }),
    ]);
    const r2 = applyAgentInnerEvent(r.process, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "布局" },
    });
    expect(r2.process?.steps[0]).toMatchObject({ kind: "thinking", text: "先看布局" });
  });

  it("tool start/end 更新状态；settled 失败若有 tool failed", () => {
    let p = applyAgentInnerEvent(null, { type: "agent_start" }).process;
    p = applyAgentInnerEvent(p, {
      type: "tool_execution_start",
      toolName: "generate_from_desk",
      toolCallId: "t1",
      args: { prompt: "暖色" },
    }).process;
    p = applyAgentInnerEvent(p, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "generate_from_desk",
      isError: true,
      result: { error: "boom" },
    }).process;
    const settled = applyAgentInnerEvent(p, { type: "agent_settled" });
    expect(settled.busy).toBe(false);
    expect(settled.chatItems).toBe("finalize");
    expect(settled.process?.status).toBe("failed");
  });

  it("settleProcessStopped 标记运行中 tool 失败", () => {
    let p = applyAgentInnerEvent(null, { type: "agent_start" }).process;
    p = applyAgentInnerEvent(p, {
      type: "tool_execution_start",
      toolName: "generate_from_desk",
      toolCallId: "t1",
    }).process;
    const r = settleProcessStopped(p);
    expect(r.busy).toBe(false);
    expect(r.process?.status).toBe("failed");
    expect(r.process?.steps[0]).toMatchObject({ status: "failed", label: "已停止" });
  });

  it("settleProcessError 附加错误消息并清 process", () => {
    const items: ChatItem[] = [{ id: "u1", role: "user", text: "hi" }];
    const p = applyAgentInnerEvent(null, { type: "agent_start" }).process!;
    const r = settleProcessError(items, p, "超时");
    expect(r.process).toBeNull();
    expect(r.items.some((i) => i.role === "agent" && i.text.includes("超时"))).toBe(true);
    expect(r.items.some((i) => i.id === PROCESS_ITEM_ID)).toBe(false);
  });
});
