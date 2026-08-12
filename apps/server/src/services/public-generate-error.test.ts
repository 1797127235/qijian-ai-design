import { describe, expect, it } from "vitest";
import { publicGenerateError } from "./canvas-generate-service.js";

describe("publicGenerateError", () => {
  it("preserves unknown model messages", () => {
    expect(publicGenerateError("未知生图 model：nope。可用：a, b")).toContain("未知生图 model");
  });

  it("preserves image service HTTP status and detail", () => {
    const msg = publicGenerateError(
      '图像服务调用失败：500{"error":{"message":"upstream error: do request failed","code":"do_request_failed"}}',
    );
    expect(msg).toContain("HTTP 500");
    expect(msg).toContain("do_request_failed");
  });

  it("maps network errors", () => {
    expect(publicGenerateError("fetch failed ETIMEDOUT")).toContain("暂时不可用");
  });

  it("falls back for opaque messages", () => {
    expect(publicGenerateError("something internal boom")).toBe("生成失败，请稍后重试");
  });
});
