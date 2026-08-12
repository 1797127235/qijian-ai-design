import { describe, expect, it } from "vitest";
import { formatChatContext, runStatusMessage } from "./chat-service.js";

describe("formatChatContext", () => {
  it("keeps roles and chronological order", () => {
    expect(formatChatContext([
      { role: "user", text: "先分析客厅" },
      { role: "assistant", text: "已整理动线问题" },
    ])).toBe("设计师：先分析客厅\n\n设计助手：已整理动线问题");
  });

  it("keeps the newest messages when the context budget is limited", () => {
    const context = formatChatContext([
      { role: "user", text: "很早的消息" },
      { role: "assistant", text: "最新回复" },
    ], 12);
    expect(context).not.toContain("很早的消息");
    expect(context).toContain("最新回复");
  });
});

describe("runStatusMessage", () => {
  it("turns a recovered interrupted run into a visible persisted-history item", () => {
    expect(runStatusMessage({
      id: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      userMessageId: "message-1",
      status: "interrupted",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:01:00.000Z",
    })).toMatchObject({
      id: "run-status:run-1",
      role: "assistant",
      text: expect.stringContaining("服务重启或异常退出而中断"),
      createdAt: "2026-08-05T08:01:00.000Z",
    });
  });

  it("does not add a synthetic message for a completed run", () => {
    expect(runStatusMessage({
      id: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      userMessageId: "message-1",
      status: "completed",
      startedAt: "2026-08-05T08:00:00.000Z",
    })).toBeUndefined();
  });

  it("surfaces the wake-guard reason verbatim on a failed run", () => {
    expect(runStatusMessage({
      id: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      userMessageId: "message-1",
      status: "failed",
      error: "当前轮次用于读取并汇报后台任务结果；新的用户操作请求会开启可执行轮次。",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:01:00.000Z",
    })).toMatchObject({
      text: expect.stringContaining("汇报后台任务结果"),
    });
  });
});
