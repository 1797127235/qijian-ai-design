import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { chatMessageAttachments, storedFiles } from "../../db/schema.js";
import type { ChatAttachmentDto } from "./types.js";

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

export async function messageReferencesFile(executor: Pick<Database, "select">, fileId: string): Promise<boolean> {
  const [hit] = await executor
    .select({ fileId: chatMessageAttachments.fileId })
    .from(chatMessageAttachments)
    .where(eq(chatMessageAttachments.fileId, fileId))
    .limit(1);
  return Boolean(hit);
}
