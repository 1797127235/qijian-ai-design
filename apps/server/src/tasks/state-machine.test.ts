import { describe, expect, it } from "vitest";
import {
  applyBatchOutcome,
  classifyGenerateError,
  classifyTaskError,
  createBatchProgress,
  deriveBatchStatus,
  imageRetryBackoffMs,
} from "./state-machine.js";

describe("batch task state", () => {
  it("deduplicates repeated terminal events by task id", () => {
    const initial = createBatchProgress(2);
    const once = applyBatchOutcome(initial, { taskId: "a", status: "succeeded" });
    const duplicate = applyBatchOutcome(once, { taskId: "a", status: "succeeded" });
    expect(duplicate).toEqual(once);
    expect(duplicate.completed).toBe(1);
  });

  it("derives partial failure without counting naming tasks", () => {
    let progress = createBatchProgress(2);
    progress = applyBatchOutcome(progress, { taskId: "image-a", status: "succeeded" });
    progress = applyBatchOutcome(progress, { taskId: "name-a", status: "failed", role: "name" });
    progress = applyBatchOutcome(progress, { taskId: "image-b", status: "failed" });
    expect(progress.completed).toBe(2);
    expect(deriveBatchStatus(progress)).toBe("partial_failed");
  });
});

describe("task retry classification", () => {
  it("retries explicit transient failures", () => {
    expect(classifyTaskError({ code: "RATE_LIMITED" })).toBe("retry");
    expect(classifyTaskError({ code: "PROVIDER_5XX" })).toBe("retry");
  });

  it("does not blindly retry ambiguous provider timeouts", () => {
    expect(classifyTaskError({ code: "PROVIDER_TIMEOUT" })).toBe("needs_review");
    expect(classifyTaskError({ code: "NETWORK", providerAccepted: "unknown" })).toBe("needs_review");
  });

  it("fails non-retryable validation and authentication errors", () => {
    expect(classifyTaskError({ code: "VALIDATION" })).toBe("fail");
    expect(classifyTaskError({ code: "PROVIDER_AUTH" })).toBe("fail");
  });
});

describe("classifyGenerateError", () => {
  it("maps rate limits and connect failures to safe auto-retry codes", () => {
    expect(classifyGenerateError(new Error("图像服务调用失败：429：rate limited")).code).toBe("RATE_LIMITED");
    expect(classifyGenerateError(new Error("图像服务网络错误：ECONNREFUSED")).code).toBe("NETWORK");
    expect(classifyGenerateError(new Error("图像服务网络错误：ECONNREFUSED")).providerAccepted).toBe("no");
    expect(classifyGenerateError(new Error("图像服务调用失败：503：upstream")).code).toBe("PROVIDER_5XX");
  });

  it("maps validation and timeouts conservatively", () => {
    expect(classifyGenerateError(new Error("未知生图 model：x")).code).toBe("VALIDATION");
    expect(classifyGenerateError(Object.assign(new Error("aborted"), { name: "AbortError" })).code)
      .toBe("PROVIDER_TIMEOUT");
  });
});

describe("imageRetryBackoffMs", () => {
  it("grows exponentially and caps at 60s", () => {
    expect(imageRetryBackoffMs(0, 2_000)).toBe(2_000);
    expect(imageRetryBackoffMs(1, 2_000)).toBe(4_000);
    expect(imageRetryBackoffMs(2, 2_000)).toBe(8_000);
    expect(imageRetryBackoffMs(10, 2_000)).toBe(60_000);
  });
});
