import type { BatchStatus } from "./types.js";

export type ImageTerminalStatus = "succeeded" | "failed" | "cancelled";

export type BatchProgress = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  terminalByTaskId: Record<string, ImageTerminalStatus>;
};

export function createBatchProgress(total: number): BatchProgress {
  if (!Number.isInteger(total) || total < 0) throw new Error("batch total must be non-negative");
  return {
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    terminalByTaskId: {},
  };
}

export function applyBatchOutcome(
  progress: BatchProgress,
  outcome: { taskId: string; status: ImageTerminalStatus; role?: "image" | "name" },
): BatchProgress {
  if (outcome.role === "name" || progress.terminalByTaskId[outcome.taskId]) return progress;
  if (progress.completed >= progress.total) throw new Error("batch already has all image outcomes");
  return {
    ...progress,
    completed: progress.completed + 1,
    succeeded: progress.succeeded + (outcome.status === "succeeded" ? 1 : 0),
    failed: progress.failed + (outcome.status === "failed" ? 1 : 0),
    cancelled: progress.cancelled + (outcome.status === "cancelled" ? 1 : 0),
    terminalByTaskId: {
      ...progress.terminalByTaskId,
      [outcome.taskId]: outcome.status,
    },
  };
}

export function deriveBatchStatus(progress: BatchProgress): BatchStatus {
  if (progress.completed === 0 && progress.total > 0) return "accepted";
  if (progress.completed < progress.total) return "running";
  if (progress.failed === 0 && progress.cancelled === 0) return "succeeded";
  if (progress.succeeded > 0 && progress.cancelled > 0) return "cancelled_with_side_effect";
  if (progress.succeeded > 0 && progress.failed > 0) return "partial_failed";
  if (progress.failed > 0) return "failed";
  return "cancelled";
}

export type TaskErrorCode =
  | "VALIDATION"
  | "PROVIDER_AUTH"
  | "RATE_LIMITED"
  | "PROVIDER_5XX"
  | "PROVIDER_TIMEOUT"
  | "NETWORK"
  | "INTERNAL";

export type RetryDecision = "retry" | "needs_review" | "fail";

export function classifyTaskError(error: {
  code: TaskErrorCode;
  providerAccepted?: "yes" | "no" | "unknown";
}): RetryDecision {
  if (error.code === "VALIDATION" || error.code === "PROVIDER_AUTH") return "fail";
  if (error.code === "RATE_LIMITED" || error.code === "PROVIDER_5XX") return "retry";
  if (error.code === "PROVIDER_TIMEOUT") return "needs_review";
  if (error.code === "NETWORK") {
    return error.providerAccepted === "no" ? "retry" : "needs_review";
  }
  return "fail";
}

/** 退避：base * 2^(attemptIndex)，attemptIndex 从 0 起；封顶 60s。 */
export function imageRetryBackoffMs(attemptIndex: number, baseMs: number): number {
  const base = Math.max(1, Math.floor(baseMs));
  const exp = Math.min(16, Math.max(0, Math.floor(attemptIndex)));
  return Math.min(60_000, base * (2 ** exp));
}

/**
 * 将 generate() 抛错映射为任务错误码。
 * 依赖 message/status 启发式（当前网关无结构化 code）；宁可 needs_review 也不要误重试开画。
 */
export function classifyGenerateError(error: unknown): {
  code: TaskErrorCode;
  providerAccepted?: "yes" | "no" | "unknown";
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : undefined;

  if (name === "AbortError" || /aborted|timeout|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(message)) {
    return { code: "PROVIDER_TIMEOUT", providerAccepted: "unknown", message };
  }
  if (status === 400 || status === 422 || /未知生图 model|VALIDATION|invalid_request/i.test(message)) {
    return { code: "VALIDATION", message };
  }
  if (status === 401 || status === 403 || /api[_ ]?key|unauthorized|forbidden|鉴权|未配置 IMAGE_API/i.test(message)) {
    return { code: "PROVIDER_AUTH", message };
  }
  if (status === 429 || /\b429\b|rate[_ ]?limit|too many requests|限流/i.test(message)) {
    return { code: "RATE_LIMITED", message };
  }
  if (
    /网络错误|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT|fetch failed|socket hang up/i.test(message)
    && !/调用失败：\s*[45]\d\d/.test(message)
  ) {
    return { code: "NETWORK", providerAccepted: "no", message };
  }
  if (status === 502 || status === 503 || status === 504 || /调用失败：\s*5\d\d|\b5\d\d\b/.test(message)) {
    return { code: "PROVIDER_5XX", message };
  }
  if (status !== undefined && status >= 500) {
    return { code: "PROVIDER_5XX", message };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { code: "VALIDATION", message };
  }
  return { code: "INTERNAL", message };
}
