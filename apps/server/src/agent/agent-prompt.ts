import type { ChatAttachmentDto } from "../services/chat-service.js";

/**
 * 拼装本轮 user prompt：用户原文 + 附件清单（带 PDF 页数提示 + source_file_id）。
 * 历史恢复由 session.prompt() 自己处理（pi 的 SessionManager.continueRecent），
 * 这里只负责「这一条消息」的形态。
 */
export function agentPrompt(text: string, attachments: ChatAttachmentDto[]) {
  const base = text.trim() || "请分析这些附件，并根据当前项目上下文继续设计。";
  if (attachments.length === 0) return base;
  const list = attachments.map((attachment) => {
    const pageNote = attachment.mediaType === "application/pdf"
      ? `，PDF ${attachment.pageCount ?? "未知"} 页${(attachment.pageCount ?? 0) > 8 ? "，本次提供前 8 页视觉内容" : ""}`
      : "";
    return `- ${attachment.originalFilename}${pageNote} [source_file_id: ${attachment.id}]`;
  }).join("\n");
  return `${base}\n\n本条消息附件：\n${list}`;
}
