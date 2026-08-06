import type { ChatAttachmentDto } from "../services/chat-service.js";

/** 本轮 user 文本 + 附件清单（仅当轮 prompt，不负责历史恢复）。 */
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
