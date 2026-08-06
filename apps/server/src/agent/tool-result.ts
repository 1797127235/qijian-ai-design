/** 工具结果业务失败判定（与前端 process-summary 对齐）。 */

function contentText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) => (
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? [(item as { text: string }).text]
        : []
    ))
    .join("\n")
    .trim();
  return text || undefined;
}

/** fail() / status=failed / isError / 常见失败文案 → 业务失败。 */
export function isToolBusinessFailure(result: unknown, isError?: boolean): boolean {
  if (isError) return true;
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (d.ok === false || d.status === "failed") return true;
  }
  const text = contentText(result);
  return Boolean(text && /失败|错误|未找到|不能|无法/.test(text));
}

export function toolFailureMessage(result: unknown): string | undefined {
  if (result && typeof result === "object") {
    const details = (result as { details?: Record<string, unknown> }).details;
    if (typeof details?.error === "string" && details.error.trim()) {
      return details.error.trim().slice(0, 2_000);
    }
  }
  return contentText(result)?.slice(0, 2_000);
}
