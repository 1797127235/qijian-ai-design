/**
 * 图片 caption 缓存读写（独立表，不进 artifact payload）。
 * 合同：project 隔离；hit 需 file_id + content_hash + analyzer_version 全匹配。
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { imageCaptions, storedFiles } from "../db/schema.js";

export type CaptionHit = {
  fileId: string;
  text: string;
  contentHash: string;
  analyzerVersion: string;
};

export type CaptionLookupKey = {
  fileId: string;
  contentHash: string;
  analyzerVersion: string;
};

export class ImageCaptionStore {
  constructor(private readonly db: Database) {}

  /**
   * 批量查询 hit。仅返回三元组全匹配的行。
   * 调用方传入期望的 contentHash / analyzerVersion。
   */
  async getMany(
    projectId: string,
    keys: CaptionLookupKey[],
  ): Promise<Map<string, CaptionHit>> {
    const out = new Map<string, CaptionHit>();
    if (keys.length === 0) return out;
    const fileIds = [...new Set(keys.map((k) => k.fileId))];
    const rows = await this.db
      .select({
        fileId: imageCaptions.fileId,
        text: imageCaptions.text,
        contentHash: imageCaptions.contentHash,
        analyzerVersion: imageCaptions.analyzerVersion,
      })
      .from(imageCaptions)
      .where(and(
        eq(imageCaptions.projectId, projectId),
        inArray(imageCaptions.fileId, fileIds),
      ));

    const want = new Map(
      keys.map((k) => [`${k.fileId}\0${k.contentHash}\0${k.analyzerVersion}`, k]),
    );
    for (const row of rows) {
      const key = `${row.fileId}\0${row.contentHash}\0${row.analyzerVersion}`;
      if (!want.has(key)) continue;
      out.set(row.fileId, {
        fileId: row.fileId,
        text: row.text,
        contentHash: row.contentHash,
        analyzerVersion: row.analyzerVersion,
      });
    }
    return out;
  }

  /**
   * 幂等写入。写前校验 stored_files 仍属于项目且 content_hash 一致（CAS）。
   * 返回 false 表示文件不存在/租户不符/hash 已变（拒旧写）。
   */
  async upsert(input: {
    projectId: string;
    fileId: string;
    contentHash: string;
    analyzerVersion: string;
    text: string;
  }): Promise<boolean> {
    const [file] = await this.db
      .select({
        id: storedFiles.id,
        contentHash: storedFiles.contentHash,
        projectId: storedFiles.projectId,
      })
      .from(storedFiles)
      .where(and(
        eq(storedFiles.id, input.fileId),
        eq(storedFiles.projectId, input.projectId),
      ));
    if (!file || file.contentHash !== input.contentHash) return false;

    const text = input.text.slice(0, 200);
    const now = new Date();
    await this.db
      .insert(imageCaptions)
      .values({
        projectId: input.projectId,
        fileId: input.fileId,
        contentHash: input.contentHash,
        analyzerVersion: input.analyzerVersion,
        text,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          imageCaptions.projectId,
          imageCaptions.fileId,
          imageCaptions.contentHash,
          imageCaptions.analyzerVersion,
        ],
        set: { text, updatedAt: now },
      });
    return true;
  }

  /** 取 stored_files 的 content_hash（租户过滤）。 */
  async fileHashes(
    projectId: string,
    fileIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(fileIds.filter(Boolean))];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;
    const rows = await this.db
      .select({ id: storedFiles.id, contentHash: storedFiles.contentHash })
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, unique)));
    for (const row of rows) out.set(row.id, row.contentHash);
    return out;
  }
}
