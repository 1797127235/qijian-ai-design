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

export type { AgentImageContent, VisualAttachment } from "./agent-image-loader.js";
export { inspectUpload } from "./upload-inspector.js";

export interface FileReferenceChecker {
  referencesFile(fileId: string): Promise<boolean>;
}

export interface StoredFileResult {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  url: string;
}

export class FileStorage {
  private referenceCheckers: FileReferenceChecker[] = [];

  constructor(private readonly db: Database, private readonly config: ServerConfig) {}

  setReferenceCheckers(checkers: FileReferenceChecker[]) {
    this.referenceCheckers = checkers;
  }

  async getById(fileId: string) {
    const [stored] = await this.db.select().from(storedFiles).where(eq(storedFiles.id, fileId));
    return stored ?? null;
  }

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
    return loadAgentImages(this.db, (objectKey) => this.read(objectKey), projectId, attachments);
  }

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
