import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { chatMessageAttachments, chatMessages, chatRuns, chatThreads, chatToolCalls, storedFiles } from "../db/schema.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../domain/attachment-limits.js";
import { AppError } from "../lib/errors.js";
import { loadAttachmentMap, messageReferencesFile } from "./chat/attachment-map.js";
import {
  formatChatContext,
  runStatusMessage,
  toMessageDto,
  toRunDto,
  toThreadDto,
  toToolCallDto,
  type ChatMessageDto,
  type ChatRole,
  type ChatRunDto,
  type ChatRunStatus,
  type ChatThreadDto,
  type ChatToolCallDto,
  type ChatToolCallStatus,
} from "./chat/types.js";

export type {
  ChatAttachmentDto,
  ChatMessageDto,
  ChatRole,
  ChatRunDto,
  ChatRunStatus,
  ChatThreadDto,
  ChatToolCallDto,
  ChatToolCallStatus,
} from "./chat/types.js";
export { formatChatContext, runStatusMessage } from "./chat/types.js";

export class ChatService {
  private readonly instanceId = randomUUID();

  constructor(private readonly db: Database) {}

  async createThread(projectId: string): Promise<ChatThreadDto> {
    const [thread] = await this.db.insert(chatThreads).values({ projectId }).returning();
    return toThreadDto(thread);
  }

  async resolveThread(projectId: string, threadId?: string) {
    if (threadId) {
      const [thread] = await this.db
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId)));
      if (!thread) throw new Error("对话不存在或不属于当前项目");
      return thread;
    }

    const [latest] = await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    if (latest) return latest;
    const created = await this.createThread(projectId);
    const [thread] = await this.db.select().from(chatThreads).where(eq(chatThreads.id, created.id));
    return thread;
  }

  async listThreads(projectId: string): Promise<ChatThreadDto[]> {
    const rows = await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.updatedAt));
    return rows.map(toThreadDto);
  }

  async deleteThread(projectId: string, threadId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId)))
      .returning({ id: chatThreads.id });
    if (!deleted) throw new Error("对话不存在或不属于当前项目");
  }

  async referencesFile(fileId: string): Promise<boolean> {
    return messageReferencesFile(this.db, fileId);
  }

  async append(
    projectId: string,
    threadId: string,
    role: ChatRole,
    text: string,
    externalId?: string,
    runId?: string,
  ): Promise<{ message: ChatMessageDto; created: boolean }> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("聊天消息不能为空");

    if (externalId) {
      const [existing] = await this.db.select().from(chatMessages).where(eq(chatMessages.externalId, externalId));
      if (existing) return { message: toMessageDto(existing), created: false };
    }

    const thread = await this.resolveThread(projectId, threadId);
    const [created] = externalId
      ? await this.db
          .insert(chatMessages)
          .values({ threadId: thread.id, projectId, role, text: trimmed, externalId, runId })
          .onConflictDoNothing({ target: chatMessages.externalId })
          .returning()
      : await this.db
          .insert(chatMessages)
          .values({ threadId: thread.id, projectId, role, text: trimmed, runId })
          .returning();

    if (created) {
      const now = new Date();
      const title = role === "user" && thread.title === "新对话"
        ? trimmed.replace(/\s+/g, " ").slice(0, 28)
        : thread.title;
      await this.db
        .update(chatThreads)
        .set({ title, updatedAt: now })
        .where(eq(chatThreads.id, thread.id));
      return { message: toMessageDto(created), created: true };
    }
    const [existing] = await this.db.select().from(chatMessages).where(eq(chatMessages.externalId, externalId!));
    if (!existing) throw new Error("聊天消息保存失败");
    return { message: toMessageDto(existing), created: false };
  }

  async appendPrompt(
    projectId: string,
    threadId: string,
    text: string,
    externalId?: string,
    attachmentIds: string[] = [],
  ): Promise<{ message: ChatMessageDto; run?: ChatRunDto; created: boolean }> {
    const trimmed = text.trim();
    const uniqueAttachmentIds = [...new Set(attachmentIds)];
    if (!trimmed && uniqueAttachmentIds.length === 0) {
      throw new AppError(422, "VALIDATION_FAILED", "消息或附件至少需要一项");
    }
    if (uniqueAttachmentIds.length !== attachmentIds.length) {
      throw new AppError(422, "VALIDATION_FAILED", "附件列表包含重复项");
    }
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new AppError(422, "VALIDATION_FAILED", `每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
    }

    return this.db.transaction(async (tx) => {
      const [thread] = await tx
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId)))
        .for("update");
      if (!thread) throw new AppError(404, "NOT_FOUND", "对话不存在或不属于当前项目");

      if (externalId) {
        const [existing] = await tx.select().from(chatMessages).where(eq(chatMessages.externalId, externalId));
        if (existing) {
          const attachments = (await loadAttachmentMap(tx, [existing.id])).get(existing.id) ?? [];
          const sameAttachments = attachments.map((item) => item.id).join(",") === attachmentIds.join(",");
          if (existing.projectId !== projectId || existing.threadId !== threadId || existing.text !== trimmed || !sameAttachments) {
            throw new AppError(409, "CONFLICT", "同一个消息标识不能用于不同内容");
          }
          return { message: toMessageDto(existing, attachments), created: false };
        }
      }

      const [running] = await tx
        .select({ id: chatRuns.id })
        .from(chatRuns)
        .where(and(eq(chatRuns.threadId, threadId), eq(chatRuns.status, "running")))
        .limit(1);
      if (running) {
        // 清扫陈旧 run：其他实例残留，或本实例挂死超过 10 分钟（模型调用无超时兜底）
        const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
        const swept = await tx
          .update(chatRuns)
          .set({ status: "interrupted", error: "任务残留自动清理", finishedAt: new Date() })
          .where(and(
            eq(chatRuns.id, running.id),
            eq(chatRuns.status, "running"),
            or(ne(chatRuns.ownerId, this.instanceId), lt(chatRuns.startedAt, staleBefore)),
          ))
          .returning({ id: chatRuns.id });
        if (swept.length === 0) {
          throw new AppError(409, "ATTACHMENT_BUSY", "当前对话仍有任务在执行，请稍后再发送", true);
        }
      }

      const files = uniqueAttachmentIds.length === 0
        ? []
        : await tx.select().from(storedFiles).where(and(
            eq(storedFiles.projectId, projectId),
            inArray(storedFiles.id, uniqueAttachmentIds),
          ));
      if (files.length !== uniqueAttachmentIds.length) {
        throw new AppError(422, "ATTACHMENT_NOT_FOUND", "一个或多个附件不存在或不属于当前项目");
      }
      if (files.reduce((total, file) => total + file.sizeBytes, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new AppError(422, "VALIDATION_FAILED", "每条消息的附件总大小不能超过 60MB");
      }
      const fileById = new Map(files.map((file) => [file.id, file]));
      const [message] = externalId
        ? await tx
            .insert(chatMessages)
            .values({ threadId, projectId, role: "user", text: trimmed, externalId })
            .onConflictDoNothing({ target: chatMessages.externalId })
            .returning()
        : await tx.insert(chatMessages).values({ threadId, projectId, role: "user", text: trimmed }).returning();
      if (!message) {
        const [existing] = await tx.select().from(chatMessages).where(eq(chatMessages.externalId, externalId!));
        if (!existing) throw new Error("聊天消息保存失败");
        const attachments = (await loadAttachmentMap(tx, [existing.id])).get(existing.id) ?? [];
        return { message: toMessageDto(existing, attachments), created: false };
      }
      if (attachmentIds.length > 0) {
        await tx.insert(chatMessageAttachments).values(attachmentIds.map((fileId, position) => ({
          messageId: message.id,
          fileId,
          position,
        })));
      }
      const attachments = attachmentIds.map((id, position) => {
        const file = fileById.get(id)!;
        return {
          id,
          originalFilename: file.originalFilename,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          pageCount: file.pageCount ?? undefined,
          position,
        };
      });
      const now = new Date();
      const titleSource = trimmed || attachments[0]?.originalFilename || "新对话";
      await tx
        .update(chatThreads)
        .set({
          title: thread.title === "新对话" ? titleSource.replace(/\s+/g, " ").slice(0, 28) : thread.title,
          updatedAt: now,
        })
        .where(eq(chatThreads.id, thread.id));
      const [run] = await tx
        .insert(chatRuns)
        .values({ projectId, threadId, userMessageId: message.id, ownerId: this.instanceId })
        .returning();
      return { message: toMessageDto(message, attachments), run: toRunDto(run), created: true };
    });
  }

  async startToolCall(runId: string, toolCallId: string, toolName: string, args: unknown) {
    const [created] = await this.db
      .insert(chatToolCalls)
      .values({ runId, toolCallId, toolName, args })
      .onConflictDoNothing({ target: [chatToolCalls.runId, chatToolCalls.toolCallId] })
      .returning();
    return created ? toToolCallDto(created) : undefined;
  }

  async finishToolCall(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    error?: string,
    cost?: unknown,
  ) {
    const finishedAt = new Date();
    const [row] = await this.db
      .insert(chatToolCalls)
      .values({
        runId,
        toolCallId,
        toolName,
        status: isError ? "failed" : "succeeded",
        args: {},
        result,
        error: error?.slice(0, 2_000),
        cost,
        finishedAt,
      })
      .onConflictDoUpdate({
        target: [chatToolCalls.runId, chatToolCalls.toolCallId],
        set: {
          toolName,
          status: isError ? "failed" : "succeeded",
          result,
          error: error?.slice(0, 2_000),
          cost,
          finishedAt,
        },
      })
      .returning();
    return toToolCallDto(row);
  }

  async finishRun(runId: string, status: Exclude<ChatRunStatus, "running" | "interrupted">, error?: string) {
    const run = await this.db.transaction(async (tx) => {
      const [finished] = await tx
        .update(chatRuns)
        .set({ status, error: error?.slice(0, 2_000), finishedAt: new Date() })
        .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "running")))
        .returning();
      if (!finished) return undefined;
      const toolStatus: ChatToolCallStatus = status === "failed" ? "failed" : "interrupted";
      await tx
        .update(chatToolCalls)
        .set({
          status: toolStatus,
          error: status === "failed" ? error?.slice(0, 2_000) : "任务结束前未收到工具完成事件",
          finishedAt: new Date(),
        })
        .where(and(eq(chatToolCalls.runId, runId), eq(chatToolCalls.status, "running")));
      return finished;
    });
    return run ? runStatusMessage(toRunDto(run)) : undefined;
  }

  async finishRunningRuns(projectId: string, threadId: string, status: "stopped" | "failed", error?: string) {
    const rows = await this.db.transaction(async (tx) => {
      const finished = await tx
        .update(chatRuns)
        .set({ status, error: error?.slice(0, 2_000), finishedAt: new Date() })
        .where(and(
          eq(chatRuns.projectId, projectId),
          eq(chatRuns.threadId, threadId),
          eq(chatRuns.ownerId, this.instanceId),
          eq(chatRuns.status, "running"),
        ))
        .returning();
      if (finished.length > 0) {
        await tx
          .update(chatToolCalls)
          .set({
            status: status === "failed" ? "failed" : "interrupted",
            error: status === "failed" ? error?.slice(0, 2_000) : "任务已停止",
            finishedAt: new Date(),
          })
          .where(and(inArray(chatToolCalls.runId, finished.map((run) => run.id)), eq(chatToolCalls.status, "running")));
      }
      return finished;
    });
    return rows.flatMap((row) => {
      const message = runStatusMessage(toRunDto(row));
      return message ? [message] : [];
    });
  }

  private async interruptStaleRuns(projectId: string, threadId: string) {
    await this.db.transaction(async (tx) => {
      const interrupted = await tx
        .update(chatRuns)
        .set({ status: "interrupted", finishedAt: new Date() })
        .where(and(
          eq(chatRuns.projectId, projectId),
          eq(chatRuns.threadId, threadId),
          eq(chatRuns.status, "running"),
          ne(chatRuns.ownerId, this.instanceId),
        ))
        .returning({ id: chatRuns.id });
      if (interrupted.length > 0) {
        await tx
          .update(chatToolCalls)
          .set({ status: "interrupted", error: "服务重启或异常退出", finishedAt: new Date() })
          .where(and(inArray(chatToolCalls.runId, interrupted.map((run) => run.id)), eq(chatToolCalls.status, "running")));
      }
    });
  }

  async history(projectId: string, threadId?: string): Promise<{ threadId: string; messages: ChatMessageDto[]; toolCalls: ChatToolCallDto[] }> {
    const thread = await this.resolveThread(projectId, threadId);
    await this.interruptStaleRuns(projectId, thread.id);
    const [rows, runs, toolCalls] = await Promise.all([
      this.db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.threadId, thread.id)))
        .orderBy(asc(chatMessages.sequence)),
      this.db
        .select()
        .from(chatRuns)
        .where(and(eq(chatRuns.projectId, projectId), eq(chatRuns.threadId, thread.id), ne(chatRuns.status, "completed"))),
      this.db
        .select({ toolCall: chatToolCalls })
        .from(chatToolCalls)
        .innerJoin(chatRuns, eq(chatToolCalls.runId, chatRuns.id))
        .where(and(eq(chatRuns.projectId, projectId), eq(chatRuns.threadId, thread.id)))
        .orderBy(desc(chatToolCalls.startedAt))
        .limit(100),
    ]);
    const attachmentByMessage = await loadAttachmentMap(this.db, rows.map((row) => row.id));
    const statusByMessage = new Map(runs.map((run) => [run.userMessageId, runStatusMessage(toRunDto(run))]));
    const messages = rows.flatMap((row) => {
      const message = toMessageDto(row, attachmentByMessage.get(row.id));
      const status = statusByMessage.get(message.id);
      return status ? [message, status] : [message];
    });
    return {
      threadId: thread.id,
      messages,
      toolCalls: toolCalls.reverse().map(({ toolCall }) => toToolCallDto(toolCall)),
    };
  }

  async recentContext(projectId: string, threadId: string, limit = 80): Promise<string> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.threadId, threadId)))
      .orderBy(desc(chatMessages.sequence))
      .limit(limit);
    return formatChatContext(rows.reverse());
  }

  async recentMessages(projectId: string, threadId: string, limit = 80): Promise<ChatMessageDto[]> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.threadId, threadId)))
      .orderBy(desc(chatMessages.sequence))
      .limit(limit);
    rows.reverse();
    const attachmentByMessage = await loadAttachmentMap(this.db, rows.map((row) => row.id));
    return rows.map((row) => toMessageDto(row, attachmentByMessage.get(row.id)));
  }
}
