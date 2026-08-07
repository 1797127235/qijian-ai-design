/**
 * 聊天附件与上传的尺寸/类型限制常量。
 * 前后端必须使用同一份数值（前端 packages/web/src/lib/attachment-limits.ts 镜像）。
 * 修改时请同步两端。
 */
/** 单个附件最大 30 MiB。 */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
/** 一条消息的所有附件合计最大 60 MiB。 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 60 * 1024 * 1024;
/** 一条消息最多挂 8 个附件。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** HTTP 整请求体最大 31 MiB（=单附件上限 + multipart 头尾冗余），用于拒超大请求早返回。 */
export const MAX_UPLOAD_CONTENT_LENGTH = 31 * 1024 * 1024;
/** 上传允许的媒体类型：PDF / JPEG / PNG。其他类型不收（不偷偷转码）。 */
export const ALLOWED_UPLOAD_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
