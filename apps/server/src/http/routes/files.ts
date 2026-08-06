import { basename } from "node:path";
import type { Hono } from "hono";
import {
  ALLOWED_UPLOAD_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_CONTENT_LENGTH,
} from "../../domain/attachment-limits.js";
import { AppError, HttpError } from "../../lib/errors.js";
import type { FileStorage } from "../../services/file-storage.js";

export function registerFileRoutes(app: Hono, deps: { files: FileStorage }) {
  app.post("/api/projects/:id/files", async (c) => {
    const contentLength = c.req.header("content-length");
    if (!contentLength) throw new AppError(400, "BAD_REQUEST", "上传请求必须提供 Content-Length");
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) throw new AppError(400, "BAD_REQUEST", "Content-Length 无效");
    if (declaredLength > MAX_UPLOAD_CONTENT_LENGTH) {
      throw new AppError(413, "UPLOAD_TOO_LARGE", "单个文件不能超过 30MB");
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(422, "请在 file 字段上传文件");
    if (!(ALLOWED_UPLOAD_MEDIA_TYPES as readonly string[]).includes(file.type)) {
      throw new AppError(422, "UNSUPPORTED_FILE_TYPE", "仅支持 PDF、JPG 和 PNG");
    }
    if (file.size > MAX_ATTACHMENT_BYTES) throw new AppError(413, "UPLOAD_TOO_LARGE", "单个文件不能超过 30MB");
    return c.json(await deps.files.put(c.req.param("id"), basename(file.name), file.type, new Uint8Array(await file.arrayBuffer())), 201);
  });

  app.delete("/api/projects/:id/files/:fileId", async (c) => {
    await deps.files.deleteUnattached(c.req.param("id"), c.req.param("fileId"));
    return c.body(null, 204);
  });

  app.get("/api/files/:id", async (c) => {
    const stored = await deps.files.getById(c.req.param("id"));
    if (!stored) throw new HttpError(404, "文件不存在");
    const bytes = await deps.files.read(stored.objectKey);
    return new Response(bytes, {
      headers: {
        "content-type": stored.mediaType,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(stored.originalFilename)}`,
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });
}
