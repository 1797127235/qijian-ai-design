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
});

describe("toolFailureMessage", () => {
  it("prefers details.error", () => {
    expect(toolFailureMessage({
      content: [{ type: "text", text: "生成失败：xxx" }],
      details: { error: "图服务返回错误" },
    })).toBe("图服务返回错误");
  });
});
