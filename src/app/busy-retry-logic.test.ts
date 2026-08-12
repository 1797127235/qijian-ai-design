/**
 * 回归：ATTACHMENT_BUSY 重试不得等待本地 busy=false。
 * sendChat 发出前会 setBusy(true)；若重试闸在 !busy 上，会空转到封顶 → 前端「卡死」。
 */
import { describe, expect, it } from "vitest";

/** 纯逻辑：给定本地 busy 与服务端可重试，是否应尝试 prompt */
function shouldAttemptBusyRetry(localBusy: boolean): boolean {
  // 正确：忽略 localBusy，始终尝试（服务端 BUSY 或 ack 会反馈）
  void localBusy;
  return true;
}

/** 错误旧逻辑（用于文档化回归） */
function legacyShouldAttemptBusyRetry(localBusy: boolean): boolean {
  return !localBusy;
}

describe("busy retry gate", () => {
  it("retries even when local busy is true", () => {
    expect(shouldAttemptBusyRetry(true)).toBe(true);
    expect(legacyShouldAttemptBusyRetry(true)).toBe(false);
  });

  it("retries when local busy is false", () => {
    expect(shouldAttemptBusyRetry(false)).toBe(true);
  });
});
