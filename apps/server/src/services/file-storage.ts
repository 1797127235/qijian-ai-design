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
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projects, storedFiles } from "../db/schema.js";
import type { ServerConfig } from "../config.js";
import { AppError, HttpError } from "../lib/errors.js";
import { loadAgentImages, type AgentImageContent, type VisualAttachment } from "./agent-image-loader.js";
import { inspectUpload } from "./upload-inspector.js";

// 重导出，让上游 services/file-storage 单一入口可拿 AgentImageContent / VisualAttachment / inspectUpload
export type { AgentImageContent, VisualAttachment } from "./agent-image-loader.js";
export { inspectUpload } from "./upload-inspector.js";

/** 引用检查可在删除事务内执行（同一连接可见未提交快照 + 行锁）。 */
export type FileReferenceExecutor = Pick<Database, "select">;

/** 谁能告诉我 file_id 是否还被引用？由 ChatService / ArtifactService 实现。 */
export interface FileReferenceChecker {
  referencesFile(fileId: string, executor?: FileReferenceExecutor): Promise<boolean>;
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

  /** 批量取 original_filename，供桌面 Survey label；缺 id 跳过。 */
  async originalFilenames(projectId: string, fileIds: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(fileIds.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = await this.db
      .select({ id: storedFiles.id, originalFilename: storedFiles.originalFilename })
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, unique)));
    const out: Record<string, string> = {};
    for (const row of rows) out[row.id] = row.originalFilename;
    return out;
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
   * 删除文件：事务内 FOR UPDATE 锁行 → 查引用 → 删行 → 再 unlink 磁盘。
   * 与 artifact/chat 写引用路径对同一 stored_files 行加锁，避免「检查无引用后被引用」的 TOCTOU。
   */
  async deleteUnattached(projectId: string, fileId: string) {
    const stored = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.projectId, projectId)))
        .for("update");
      if (!row) return null;
      for (const checker of this.referenceCheckers) {
        if (await checker.referencesFile(fileId, tx)) {
          throw new AppError(409, "CONFLICT", "附件已被消息或画布使用，不能删除");
        }
      }
      await tx.delete(storedFiles).where(eq(storedFiles.id, fileId));
      return row;
    });
    if (!stored) return false;
    await unlink(join(this.config.uploadDir, stored.objectKey)).catch(() => undefined);
    return true;
  }

  /**
   * 清理无引用 stored_files（孤儿 GC）。
   *  - minAgeMs：跳过「刚上传 / 会话 undo 窗口」内的文件，默认 1h
   *  - 逐条复用 deleteUnattached 的引用检查 + 行锁，避免 TOCTOU
   *  - 不抛单文件失败，累计 deleted/skipped/errors
   */
  async gcUnattached(options: {
    projectId?: string;
    minAgeMs?: number;
    limit?: number;
    now?: Date;
  } = {}): Promise<{ scanned: number; deleted: number; skipped: number; errors: number }> {
    const minAgeMs = options.minAgeMs ?? 60 * 60 * 1000;
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - minAgeMs);

    const conditions = [sql`${storedFiles.createdAt} <= ${cutoff}`];
    if (options.projectId) conditions.push(eq(storedFiles.projectId, options.projectId));

    const candidates = await this.db
      .select({ id: storedFiles.id, projectId: storedFiles.projectId })
      .from(storedFiles)
      .where(and(...conditions))
      .orderBy(storedFiles.createdAt)
      .limit(limit);

    let deleted = 0;
    let skipped = 0;
    let errors = 0;
    for (const row of candidates) {
      try {
        const ok = await this.deleteUnattached(row.projectId, row.id);
        if (ok) deleted += 1;
        else skipped += 1;
      } catch (error) {
        if (error instanceof AppError && error.status === 409) {
          skipped += 1;
          continue;
        }
        errors += 1;
      }
    }
    return { scanned: candidates.length, deleted, skipped, errors };
  }

  async removeProjectFiles(projectId: string, objectKeys: string[]) {
    for (const key of objectKeys) {
      await unlink(join(this.config.uploadDir, key)).catch(() => undefined);
    }
    await rm(join(this.config.uploadDir, projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}
