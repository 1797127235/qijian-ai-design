import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projects, storedFiles } from "../db/schema.js";
import type { ServerConfig } from "../config.js";
import { HttpError } from "../lib/errors.js";

export interface StoredFileResult {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
}

export class FileStorage {
  constructor(private readonly db: Database, private readonly config: ServerConfig) {}

  async put(projectId: string, filename: string, mediaType: string, bytes: Uint8Array): Promise<StoredFileResult> {
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new HttpError(404, "未找到该设计项目");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `${projectId}/${randomUUID()}${extname(filename).toLowerCase()}`;
    const path = join(this.config.uploadDir, objectKey);
    await mkdir(join(this.config.uploadDir, projectId), { recursive: true });
    await writeFile(path, bytes);
    let stored: typeof storedFiles.$inferSelect;
    try {
      [stored] = await this.db
        .insert(storedFiles)
        .values({ projectId, originalFilename: filename, mediaType, sizeBytes: bytes.byteLength, contentHash: hash, objectKey })
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
      url: `${this.config.publicBaseUrl}/api/files/${stored.id}`,
    };
  }

  async read(objectKey: string) {
    return readFile(join(this.config.uploadDir, objectKey));
  }

  async removeProjectFiles(projectId: string, objectKeys: string[]) {
    for (const key of objectKeys) {
      await unlink(join(this.config.uploadDir, key)).catch(() => undefined);
    }
    await rm(join(this.config.uploadDir, projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}
