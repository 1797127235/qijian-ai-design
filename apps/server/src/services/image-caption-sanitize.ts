/**
 * Caption 注入消毒：控制符剥离、长度截断、削弱指令形文本。
 * 输出只应出现在 user 侧 DESK/FOCUS 文本，永不进 system。
 */
export const CAPTION_MAX_CHARS = 80;

/** 当前分析器版本（模型+提示+缩放策略）。变更即全量 miss。 */
export const CAPTION_ANALYZER_VERSION = "v1|vision-brief|max80|no-resize";

export function sanitizeCaptionText(raw: string, max = CAPTION_MAX_CHARS): string {
  let text = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 削弱常见角色/指令前缀（不保证绝对安全，配合 untrusted 标签）
  text = text
    .replace(/^(system|assistant|user|developer)\s*:/gi, "")
    .replace(/```/g, "")
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/** Focus 行格式：明确 untrusted observation。 */
export function formatCaptionLine(text: string): string {
  const safe = sanitizeCaptionText(text);
  if (!safe) return "";
  return `  caption(untrusted observation): ${safe}`;
}
