/** span I/O 截断 + 字段白名单，避免密钥/过大 payload 上云。 */

const TEXT_CAP = 32_000;

const META_ALLOW = new Set([
  "project_id", "thread_id", "run_id", "tool_call_id", "tool_name", "job_id", "kind",
  "artifact_id", "source_artifact_id", "file_id", "status", "error_code", "mime",
  "bytes", "hash", "model", "provider", "truncated", "client_message_id", "connection_id",
]);

export function truncateText(value: string, max = TEXT_CAP): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

export function capJson(value: unknown, max = TEXT_CAP): unknown {
  try {
    const raw = JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v) ?? "null";
    if (raw.length <= max) return value === undefined ? null : JSON.parse(raw);
    return { truncated: true, preview: raw.slice(0, max), originalCharacters: raw.length };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : "serialize failed", truncated: true };
  }
}

/** 只保留 allowlist 元数据键；其余丢弃。 */
export function pickMeta(input?: Record<string, unknown>): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!META_ALLOW.has(key)) continue;
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? truncateText(value).text : capJson(value);
  }
  return out;
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
