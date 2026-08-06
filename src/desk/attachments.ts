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
