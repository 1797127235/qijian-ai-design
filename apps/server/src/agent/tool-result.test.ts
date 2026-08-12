import { describe, expect, it } from "vitest";
import { isToolBusinessFailure, toolFailureMessage } from "./tool-result.js";

describe("isToolBusinessFailure", () => {
  it("flags protocol errors", () => {
    expect(isToolBusinessFailure({ content: [{ type: "text", text: "ok" }] }, true)).toBe(true);
  });

  it("flags fail() details", () => {
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "生成失败" }],
      details: { ok: false, status: "failed", error: "timeout" },
    }, false)).toBe(true);
  });

  it("does not flag successful tool results", () => {
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "已生成" }],
      details: { ok: true, status: "ready", artifact_id: "a1" },
    }, false)).toBe(false);
  });

  it("treats policy denials as delivered tool results, not failures", () => {
    // 能力门拒绝是预期内的正常返回：原因随 content 回给模型，run 终态不应被污染
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "当前轮次用于读取并汇报后台任务结果；新的用户操作请求会开启可执行轮次。" }],
      details: { ok: false, error_code: "POLICY_DENIED", code: "WAKE_READ_ONLY" },
    }, false)).toBe(false);
  });
});

describe("toolFailureMessage", () => {
  it("prefers details.error", () => {
    expect(toolFailureMessage({
      content: [{ type: "text", text: "生成失败：xxx" }],
      details: { error: "图服务返回错误" },
    })).toBe("图服务返回错误");
  });
});
