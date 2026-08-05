export const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const allowedMediaTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

export function validateAttachmentFile(file: File): string | undefined {
  if (!allowedMediaTypes.has(file.type)) return "仅支持 PDF、JPG 和 PNG";
  if (file.size > MAX_ATTACHMENT_BYTES) return "单个文件不能超过 30MB";
  if (file.size === 0) return "文件内容为空";
  return undefined;
}
