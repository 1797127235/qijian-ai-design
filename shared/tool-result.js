function contentText(value) {
  if (!value || typeof value !== "object") return undefined;
  const content = value.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) => (
      item && typeof item === "object" && typeof item.text === "string"
        ? [item.text]
        : []
    ))
    .join("\n")
    .trim();
  return text || undefined;
}

export function isToolBusinessFailure(result, isError = false) {
  if (isError) return true;
  if (!result || typeof result !== "object") return false;
  const details = result.details;
  if (details && typeof details === "object") {
    if (details.ok === true) return false;
    if (details.error_code === "POLICY_DENIED") return false;
    if (details.ok === false || details.status === "failed") return true;
  }
  const text = contentText(result);
  return Boolean(text && /失败|错误|未找到|不能|无法/.test(text));
}

export function toolFailureMessage(result) {
  if (result && typeof result === "object") {
    const details = result.details;
    if (details && typeof details === "object" && typeof details.error === "string" && details.error.trim()) {
      return details.error.trim().slice(0, 2_000);
    }
  }
  return contentText(result)?.slice(0, 2_000);
}
