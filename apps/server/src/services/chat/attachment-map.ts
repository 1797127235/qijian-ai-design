/**
 * 附件批量加载工具。
 *  - 一次 SELECT 拿全 messageIds 的附件（IN 查询 + position 排序）
 *  - 返回 messageId → DTO[] 的 Map
 *  - 接受 Pick<Database, "select"> 让事务内/外都可用
 */
import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { chatMessageAttachments, storedFiles } from "../../db/schema.js";
import type { ChatAttachmentDto } from "./types.js";

/**
 * 批量加载附件：单次 SQL 查所有 message 的附件，按 position 升序排好。
 * 为什么要批：listThreads / history 一次拉几十条消息，逐条 N+1 会爆。
 */
export async function loadAttachmentMap(
  executor: Pick<Database, "select">,
  messageIds: string[],
): Promise<Map<string, ChatAttachmentDto[]>> {
  const result = new Map<string, ChatAttachmentDto[]>();
  if (messageIds.length === 0) return result;
  const rows = await executor
    .select({
      messageId: chatMessageAttachments.messageId,
      id: storedFiles.id,
      originalFilename: storedFiles.originalFilename,
      mediaType: storedFiles.mediaType,
      sizeBytes: storedFiles.sizeBytes,
      pageCount: storedFiles.pageCount,
      position: chatMessageAttachments.position,
    })
    .from(chatMessageAttachments)
    .innerJoin(storedFiles, eq(storedFiles.id, chatMessageAttachments.fileId))
    .where(inArray(chatMessageAttachments.messageId, messageIds))
    .orderBy(asc(chatMessageAttachments.position));
  for (const row of rows) {
    const items = result.get(row.messageId) ?? [];
    items.push({
      id: row.id,
      originalFilename: row.originalFilename,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      pageCount: row.pageCount ?? undefined,
      position: row.position,
    });
    result.set(row.messageId, items);
  }
  return result;
}

/** 消息↔文件引用：检查 fileId 是否还挂在某条消息上。FileStorage.deleteUnattached 会调。 */
export async function messageReferencesFile(executor: Pick<Database, "select">, fileId: string): Promise<boolean> {
  const [hit] = await executor
    .select({ fileId: chatMessageAttachments.fileId })
    .from(chatMessageAttachments)
    .where(eq(chatMessageAttachments.fileId, fileId))
    .limit(1);
  return Boolean(hit);
}
