/** 聊天附件与上传限额：前后端应对齐同一数值。 */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_UPLOAD_CONTENT_LENGTH = 31 * 1024 * 1024;
export const ALLOWED_UPLOAD_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
