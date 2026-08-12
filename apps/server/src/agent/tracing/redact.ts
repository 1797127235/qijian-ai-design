/** span I/O 截断 + 字段白名单，避免密钥/过大 payload 上云。 */

const TEXT_CAP = 32_000;

const META_ALLOW = new Set([
  "project_id", "thread_id", "run_id", "tool_call_id", "tool_name", "job_id", "kind",
  "artifact_id", "source_artifact_id", "file_id", "status", "error_code", "mime",
  "bytes", "hash", "model", "provider", "truncated", "client_message_id", "connection_id",
  "system_sha256", "tools_sha256", "history_prefix_sha256", "active_tool_count", "history_message_count",
  "tool_epoch", "working_set_sha256", "working_set_size",
  "frame_sha256",
  "trajectory_epoch",
  "turn_index",
]);

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
const SECRETISH = /\b(sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|lsv2_[a-z0-9_]{8,})\b/gi;

export function truncateText(value: string, max = TEXT_CAP): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/** 递归脱敏：敏感 key 打码；字符串中的 token 模式打码。 */
export function redactTracePayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    return truncateText(value.replace(SECRETISH, "[redacted]")).text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactTracePayload(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = redactTracePayload(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function capJson(value: unknown, max = TEXT_CAP): unknown {
  try {
    const safe = redactTracePayload(value);
    const raw = JSON.stringify(safe, (_k, v) => typeof v === "bigint" ? v.toString() : v) ?? "null";
    if (raw.length <= max) return safe === undefined ? null : safe;
    // 不导出 raw preview，避免把未脱敏大段内容送出
    return { truncated: true, originalCharacters: raw.length };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : "serialize failed", truncated: true };
  }
}

/** 只保留 allowlist 元数据键；标量优先，复杂值再 capJson。 */
export function pickMeta(input?: Record<string, unknown>): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!META_ALLOW.has(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string") out[key] = truncateText(value.replace(SECRETISH, "[redacted]")).text;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = capJson(value);
  }
  return out;
}

/** 错误消息脱敏：去 token/URL query secret，限长。 */
export function redactErrorMessage(message: string, max = 500): string {
  return truncateText(
    message
      .replace(SECRETISH, "[redacted]")
      .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi, "$1[redacted]"),
    max,
  ).text;
}

export function imageMeta(input: {
  file_id?: string;
  mime?: string;
  bytes?: number;
  hash?: string;
}): Record<string, unknown> {
  return pickMeta({
    file_id: input.file_id,
    mime: input.mime,
    bytes: input.bytes,
    hash: input.hash,
  });
}
