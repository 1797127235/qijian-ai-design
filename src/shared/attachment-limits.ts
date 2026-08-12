/** 与 apps/server/src/domain/attachment-limits.ts 保持数值一致。 */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
export const ALLOWED_UPLOAD_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
