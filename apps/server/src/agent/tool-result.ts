/**
 * 工具结果「业务失败」判定。
 *  - pi 的 isError 只在 throw 时才 true；工具内部 fail() 不抛，result.details.ok=false
 *  - 本函数统一判定：isError || details.ok===false || details.status==="failed" || 失败文案
 *  - 失败文案靠中文关键词正则（与前端 process-summary 对齐，避免前后端判失败不一致）
 */

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
    // 能力门策略拒绝是预期内的正常返回：原因随 content 回给模型，由模型调整后续动作
    if (d.error_code === "POLICY_DENIED") return false;
    if (d.ok === false || d.status === "failed") return true;
  }
  const text = contentText(result);
  return Boolean(text && /失败|错误|未找到|不能|无法/.test(text));
}

/** 从工具结果里抠出错原因：details.error 优先，content 文本兜底（截断 2000 字符防爆库）。 */
export function toolFailureMessage(result: unknown): string | undefined {
  if (result && typeof result === "object") {
    const details = (result as { details?: Record<string, unknown> }).details;
    if (typeof details?.error === "string" && details.error.trim()) {
      return details.error.trim().slice(0, 2_000);
    }
  }
  return contentText(result)?.slice(0, 2_000);
}
