/**
 * 文件存储：上传、读取、删除、附件引用检查。
 *
 *  - 上传：先 inspect（PDF 页数/图片尺寸校验）→ 写盘 → 写库；落盘与入库任一失败要回滚
 *  - objectKey = `${projectId}/${uuid}${ext}`，用项目前缀方便 rmProjectFiles 整目录删
 *  - 引用检查依赖外部注入的 FileReferenceChecker（ChatService/ArtifactService），
 *    因为只有它们知道 file_id 出现在哪些业务表里
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projects, storedFiles } from "../db/schema.js";
import type { ServerConfig } from "../config.js";
import { AppError, HttpError } from "../lib/errors.js";
import { loadAgentImages, type AgentImageContent, type VisualAttachment } from "./agent-image-loader.js";
import { inspectUpload } from "./upload-inspector.js";

// 重导出，让上游 services/file-storage 单一入口可拿 AgentImageContent / VisualAttachment / inspectUpload
export type { AgentImageContent, VisualAttachment } from "./agent-image-loader.js";
export { inspectUpload } from "./upload-inspector.js";

/** 谁能告诉我 file_id 是否还被引用？由 ChatService / ArtifactService 实现。 */
export interface FileReferenceChecker {
  referencesFile(fileId: string): Promise<boolean>;
}

/** 上传后返回给前端的精简视图（不暴露 objectKey 等内部字段）。 */
export interface StoredFileResult {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  url: string;
}

/**
 * 文件存储服务：
 *  - 落盘在 config.uploadDir/<projectId>/<uuid><ext>
 *  - 数据库记元信息 + contentHash
 *  - 删除前必须通过所有 referenceCheckers（防止删了消息里还在引用的图）
 */
export class FileStorage {
  private referenceCheckers: FileReferenceChecker[] = [];

  constructor(private readonly db: Database, private readonly config: ServerConfig) {}

  /** 注入引用检查器（必须从外部装配，构造时未知）。 */
  setReferenceCheckers(checkers: FileReferenceChecker[]) {
    this.referenceCheckers = checkers;
  }

  async getById(fileId: string) {
    const [stored] = await this.db.select().from(storedFiles).where(eq(storedFiles.id, fileId));
    return stored ?? null;
  }

  /**
   * 上传文件：写盘前先 inspect（类型/尺寸/PDF 页数）→ 落盘 → 入库；入库失败回滚盘上文件。
   * objectKey 用项目前缀做软隔离，删除项目时整目录 rm 即可。
   */
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

  /**
   * 把附件转成 Agent 可消费的多模态内容：JPEG/PNG 直接 base64；PDF 用 @napi-rs/canvas + pdfjs 渲染前 N 页成 PNG。
   * 注入 readBytes 便于测试（不必真读盘）。
   */
  async loadAgentImages(projectId: string, attachments: VisualAttachment[]): Promise<AgentImageContent[]> {
    return loadAgentImages(this.db, (objectKey) => this.read(objectKey), projectId, attachments);
  }

  /**
   * 删除文件：先问所有 referenceCheckers 是否有引用，有就 409；都没有就删 DB 行 + 磁盘文件。
   * 软删（置 deleted_at）目前未启用，但 schema 留了位（见 TODOS #1 tombstone 讨论）。
   */
  async deleteUnattached(projectId: string, fileId: string) {
    const [stored] = await this.db.select().from(storedFiles).where(and(eq(storedFiles.id, fileId), eq(storedFiles.projectId, projectId)));
    if (!stored) return false;
    for (const checker of this.referenceCheckers) {
      if (await checker.referencesFile(fileId)) {
        throw new AppError(409, "CONFLICT", "附件已被消息或画布使用，不能删除");
      }
    }
    await this.db.delete(storedFiles).where(eq(storedFiles.id, fileId));
    await unlink(join(this.config.uploadDir, stored.objectKey)).catch(() => undefined);
    return true;
  }

  async removeProjectFiles(projectId: string, objectKeys: string[]) {
    for (const key of objectKeys) {
      await unlink(join(this.config.uploadDir, key)).catch(() => undefined);
    }
    await rm(join(this.config.uploadDir, projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}
