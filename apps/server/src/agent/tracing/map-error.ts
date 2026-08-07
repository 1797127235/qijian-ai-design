/** 唯一错误码映射口：throw / fail / abort / job 终态都走这里。 */
import { redactErrorMessage } from "./redact.js";
import type { ErrorCode, MappedError } from "./types.js";

function clip(message: string): string {
  return redactErrorMessage(message.trim() || "未知错误", 2_000);
}

/** 从任意失败来源映射稳定 error_code。 */
export function mapError(input: {
  message?: string;
  name?: string;
  status?: number | string;
  code?: string;
  aborted?: boolean;
  cancelled?: boolean;
  details?: Record<string, unknown>;
}): MappedError {
  const raw = clip(
    input.message
    || (typeof input.details?.error === "string" ? input.details.error : "")
    || "未知错误",
  );
  const lower = raw.toLowerCase();
  const name = (input.name ?? "").toLowerCase();
  const statusNum = typeof input.status === "number"
    ? input.status
    : Number.parseInt(String(input.status ?? ""), 10);
  if (input.code && [
    "VALIDATION", "SOURCE_NOT_FOUND", "PROJECT_MISMATCH", "PROVIDER_4XX", "PROVIDER_5XX",
    "PROVIDER_TIMEOUT", "USER_ABORT", "JOB_CANCELLED", "INTERNAL", "SERIALIZE",
  ].includes(input.code)) {
    return { error_code: input.code as ErrorCode, message: raw };
  }

  if (input.aborted || name === "aborterror" || /已停止|用户取消|abort/.test(raw)) {
    return { error_code: "USER_ABORT", message: raw || "已停止" };
  }
  if (input.cancelled || /已取消|cancelled/.test(raw)) {
    return { error_code: "JOB_CANCELLED", message: raw || "已取消" };
  }
  if (input.code === "SERIALIZE" || /序列化|serialize/.test(lower)) {
    return { error_code: "SERIALIZE", message: raw };
  }
  if (/不属于当前项目|跨项目|project mismatch/.test(raw)) {
    return { error_code: "PROJECT_MISMATCH", message: raw };
  }
  if (/未指定源|prompt 不能为空|消息或附件|validation/.test(raw)) {
    return { error_code: "VALIDATION", message: raw };
  }
  if (/未找到|不存在/.test(raw) || /源物件无效|Artifact 不|源物件/.test(raw)) {
    return { error_code: "SOURCE_NOT_FOUND", message: raw };
  }
  if (/校验|无效/.test(raw) && !/源|Artifact|artifact/.test(raw)) {
    return { error_code: "VALIDATION", message: raw };
  }
  if (Number.isFinite(statusNum) && statusNum >= 500) {
    return { error_code: "PROVIDER_5XX", message: raw };
  }
  if (Number.isFinite(statusNum) && statusNum >= 400) {
    return { error_code: "PROVIDER_4XX", message: raw };
  }
  if (/超时|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/.test(raw) || name.includes("timeout")) {
    return { error_code: "PROVIDER_TIMEOUT", message: raw };
  }
  if (/400|401|403|404|图服务|provider|image api|generat/.test(lower) && /失败|错误|error|拒绝/.test(raw)) {
    return { error_code: "PROVIDER_4XX", message: raw };
  }
  if (/5\d\d|服务端|upstream/.test(lower)) {
    return { error_code: "PROVIDER_5XX", message: raw };
  }
  return { error_code: "INTERNAL", message: raw };
}

export function mapErrorFromUnknown(error: unknown, extra: { aborted?: boolean; cancelled?: boolean } = {}): MappedError {
  if (error && typeof error === "object") {
    const e = error as Error & { status?: number; statusCode?: number; code?: string };
    return mapError({
      message: e.message,
      name: e.name,
      status: e.status ?? e.statusCode,
      code: e.code,
      aborted: extra.aborted || e.name === "AbortError",
      cancelled: extra.cancelled,
    });
  }
  return mapError({ message: error == null ? "未知错误" : String(error), ...extra });
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && [
    "VALIDATION", "SOURCE_NOT_FOUND", "PROJECT_MISMATCH", "PROVIDER_4XX", "PROVIDER_5XX",
    "PROVIDER_TIMEOUT", "USER_ABORT", "JOB_CANCELLED", "INTERNAL", "SERIALIZE",
  ].includes(value);
}
