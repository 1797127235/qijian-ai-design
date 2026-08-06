import {
  ALLOWED_UPLOAD_MEDIA_TYPES,
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../shared/attachment-limits";

export {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
};

export function validateAttachmentFile(file: File): string | undefined {
  if (!ALLOWED_UPLOAD_MEDIA_TYPES.has(file.type)) return "仅支持 PDF、JPG 和 PNG";
  if (file.size > MAX_ATTACHMENT_BYTES) return "单个文件不能超过 30MB";
  if (file.size === 0) return "文件内容为空";
  return undefined;
}

export const CANVAS_IMAGE_ACCEPT = ".jpg,.jpeg,.png";

/** 画布图片入口仅收 JPEG/PNG（PDF 走聊天附件，见设计文档 D5 决策）。 */
export function validateCanvasImageFile(file: File): string | undefined {
  if (file.type !== "image/jpeg" && file.type !== "image/png") return "画布仅支持 JPG 和 PNG 图片，PDF 请从对话附件发送";
  if (file.size > MAX_ATTACHMENT_BYTES) return "单个文件不能超过 30MB";
  if (file.size === 0) return "文件内容为空";
  return undefined;
}
