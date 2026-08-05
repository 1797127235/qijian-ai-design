import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Database } from "../db/client.js";
import { artifactVersions, chatMessageAttachments, projects, storedFiles } from "../db/schema.js";
import type { ServerConfig } from "../config.js";
import { AppError, HttpError } from "../lib/errors.js";

export interface StoredFileResult {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  url: string;
}

export interface VisualAttachment {
  id: string;
  originalFilename: string;
  mediaType: string;
  pageCount?: number;
}

export interface AgentImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PDF_PAGES_FOR_AGENT = 8;
const MAX_RENDER_EDGE = 1_600;
const MAX_AGENT_IMAGES = 12;
const MAX_AGENT_BASE64_CHARACTERS = 24 * 1024 * 1024;

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === "image/png") {
    if (!startsWith(bytes, PNG_SIGNATURE) || buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mediaType !== "image/jpeg" || !startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

export async function inspectUpload(bytes: Uint8Array, mediaType: string): Promise<{ pageCount?: number }> {
  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions) {
    if (dimensions.width < 1 || dimensions.height < 1) {
      throw new AppError(422, "INVALID_FILE_CONTENT", "图片尺寸无效");
    }
    if (dimensions.width * dimensions.height > 80_000_000) {
      throw new AppError(422, "INVALID_FILE_CONTENT", "图片像素尺寸过大");
    }
    return {};
  }
  if (mediaType !== "application/pdf" || !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new AppError(422, "INVALID_FILE_CONTENT", "文件内容与声明的 PDF、JPG 或 PNG 类型不一致");
  }
  try {
    const loading = getDocument({ data: Uint8Array.from(bytes) });
    const document = await loading.promise;
    const pageCount = document.numPages;
    await loading.destroy();
    return { pageCount };
  } catch (error) {
    const message = error instanceof Error && /password/i.test(error.message) ? "暂不支持加密 PDF" : "PDF 文件损坏或无法读取";
    throw new AppError(422, "INVALID_FILE_CONTENT", message);
  }
}

export class FileStorage {
  constructor(private readonly db: Database, private readonly config: ServerConfig) {}

  async put(projectId: string, filename: string, mediaType: string, bytes: Uint8Array): Promise<StoredFileResult> {
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new HttpError(404, "未找到该设计项目");
    const metadata = await inspectUpload(bytes, mediaType);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `${projectId}/${randomUUID()}${extname(filename).toLowerCase()}`;
    const path = join(this.config.uploadDir, objectKey);
    await mkdir(join(this.config.uploadDir, projectId), { recursive: true });
    await writeFile(path, bytes);
    let stored: typeof storedFiles.$inferSelect;
    try {
      [stored] = await this.db
        .insert(storedFiles)
        .values({ projectId, originalFilename: filename, mediaType, sizeBytes: bytes.byteLength, contentHash: hash, objectKey, pageCount: metadata.pageCount })
        .returning();
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return {
      id: stored.id,
      originalFilename: stored.originalFilename,
      mediaType: stored.mediaType,
      sizeBytes: stored.sizeBytes,
      pageCount: stored.pageCount ?? undefined,
      url: `${this.config.publicBaseUrl}/api/files/${stored.id}`,
    };
  }

  async read(objectKey: string) {
    return readFile(join(this.config.uploadDir, objectKey));
  }

  async loadAgentImages(projectId: string, attachments: VisualAttachment[]): Promise<AgentImageContent[]> {
    if (attachments.length === 0) return [];
    const rows = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, attachments.map((item) => item.id))));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const images: AgentImageContent[] = [];
    for (const attachment of attachments) {
      const stored = byId.get(attachment.id);
      if (!stored) throw new AppError(404, "ATTACHMENT_NOT_FOUND", `附件不存在：${attachment.originalFilename}`);
      const bytes = await this.read(stored.objectKey);
      if (stored.mediaType === "image/jpeg" || stored.mediaType === "image/png") {
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: stored.mediaType });
      } else {
        const remainingPages = MAX_AGENT_IMAGES - images.length;
        if (remainingPages < Math.min(stored.pageCount ?? MAX_PDF_PAGES_FOR_AGENT, MAX_PDF_PAGES_FOR_AGENT)) {
          throw new AppError(422, "VALIDATION_FAILED", "附件视觉内容超过模型处理上限，请减少文件或 PDF 页数");
        }
        images.push(...await this.renderPdf(bytes, stored.pageCount ?? undefined, remainingPages));
      }
      if (images.length > MAX_AGENT_IMAGES || images.reduce((total, image) => total + image.data.length, 0) > MAX_AGENT_BASE64_CHARACTERS) {
        throw new AppError(422, "VALIDATION_FAILED", "附件视觉内容超过模型处理上限，请减少文件或 PDF 页数");
      }
    }
    return images;
  }

  async deleteUnattached(projectId: string, fileId: string) {
    const [stored] = await this.db.select().from(storedFiles).where(and(eq(storedFiles.id, fileId), eq(storedFiles.projectId, projectId)));
    if (!stored) return false;
    const [[messageRef], [artifactRef]] = await Promise.all([
      this.db.select({ fileId: chatMessageAttachments.fileId }).from(chatMessageAttachments).where(eq(chatMessageAttachments.fileId, fileId)).limit(1),
      this.db.select({ id: artifactVersions.id }).from(artifactVersions).where(sql`${artifactVersions.inputRefs}::text LIKE ${`%${fileId}%`} OR ${artifactVersions.payload}::text LIKE ${`%${fileId}%`}`).limit(1),
    ]);
    if (messageRef || artifactRef) throw new AppError(409, "CONFLICT", "附件已被消息或画布使用，不能删除");
    await this.db.delete(storedFiles).where(eq(storedFiles.id, fileId));
    await unlink(join(this.config.uploadDir, stored.objectKey)).catch(() => undefined);
    return true;
  }

  private async renderPdf(bytes: Uint8Array, knownPageCount?: number, remainingPages = MAX_PDF_PAGES_FOR_AGENT): Promise<AgentImageContent[]> {
    const loading = getDocument({ data: Uint8Array.from(bytes) });
    const document = await loading.promise;
    try {
      const pageCount = Math.min(knownPageCount ?? document.numPages, MAX_PDF_PAGES_FOR_AGENT, Math.max(0, remainingPages));
      const images: AgentImageContent[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_RENDER_EDGE / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        const context = canvas.getContext("2d");
        await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
        images.push({ type: "image", data: canvas.toBuffer("image/png").toString("base64"), mimeType: "image/png" });
        page.cleanup();
      }
      return images;
    } finally {
      await loading.destroy();
    }
  }

  async removeProjectFiles(projectId: string, objectKeys: string[]) {
    for (const key of objectKeys) {
      await unlink(join(this.config.uploadDir, key)).catch(() => undefined);
    }
    await rm(join(this.config.uploadDir, projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}
