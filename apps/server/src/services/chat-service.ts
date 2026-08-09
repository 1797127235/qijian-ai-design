import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
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
  isInternalSystemChatMessage,
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
export { formatChatContext, isInternalSystemChatMessage, runStatusMessage } from "./chat/types.js";

/**
 * 聊天服务：thread/message/run/tool_call 的 CRUD 与协作语义。
 *
 * 关键并发模型：
 *  - 同一 thread 只能有一个 running run（DB partial unique 索引兜底）
 *  - instanceId（进程 UUID）标识「我」创建/拥有的 run，方便别人清扫我挂死的 run
 *  - 陈旧 run 自动清理：本实例以外的 running run 自动标 interrupted
 *    自己的 run 超过 10 分钟未结束也视作挂死（模型无超时兜底）
 *
 * 幂等：
 *  - chat_messages.external_id 唯一（前端断网重发同一消息不重复入库）
 *  - 同 external_id 但内容不一致 → 409
 */
export class ChatService {
  /** 当前进程 UUID，挂在每个 run 的 ownerId 上，便于跨实例清扫。 */
  private readonly instanceId = randomUUID();

  constructor(private readonly db: Database) {}

  async createThread(projectId: string): Promise<ChatThreadDto> {
    const [thread] = await this.db.insert(chatThreads).values({ projectId }).returning();
    return toThreadDto(thread);
  }

  /**
   * 解析 thread：传 threadId 时校验归属；不传则取最新；都没有就新建（一个项目起步时也有 thread）。
   * 历史数据中的 latest 也兼容「无 thread」的情况。
   */
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

  async referencesFile(fileId: string, executor: Parameters<typeof messageReferencesFile>[0] = this.db): Promise<boolean> {
    return messageReferencesFile(executor, fileId);
  }

  /**
   * 追加一条非 user 消息（assistant 文本、状态文案等）。
   * externalId 可选：传了则按幂等键去重；不传则直接 insert。
   * 不做 running 互斥检查（这是 user prompt 路径的职责，见 appendPrompt）。
   */
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

  /**
   * 核心入口：用户发送 prompt。
   * 事务内完成：参数校验 → 附件所有权校验 → 插 user_message → 插关联附件 → 起 run。
   * 互斥语义：发现本 thread 有 running run 时，区分「我自己的」与「他实例的」；
   *  他实例的立刻 interrupted，本实例超过 10 分钟也视作挂死清掉。
   *  互斥的意图不是「拒绝重发」，而是「不要在已有任务上再叠一个」。
   */
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
        // 仅超时才清扫；owner 不等不等于已死（多实例误杀活任务）
        const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
        const swept = await tx
          .update(chatRuns)
          .set({ status: "interrupted", error: "任务超时自动清理", finishedAt: new Date() })
          .where(and(
            eq(chatRuns.id, running.id),
            eq(chatRuns.status, "running"),
            lt(chatRuns.startedAt, staleBefore),
          ))
          .returning({ id: chatRuns.id });
        if (swept.length === 0) {
          throw new AppError(409, "ATTACHMENT_BUSY", "当前对话仍有任务在执行，请稍后再发送", true);
        }
        await tx
          .update(chatToolCalls)
          .set({ status: "interrupted", error: "任务超时自动清理", finishedAt: new Date() })
          .where(and(inArray(chatToolCalls.runId, swept.map((run) => run.id)), eq(chatToolCalls.status, "running")));
      }

      // FOR UPDATE：与 FileStorage.deleteUnattached 互斥，避免消息挂上已删/正删文件
      const files = uniqueAttachmentIds.length === 0
        ? []
        : await tx.select().from(storedFiles).where(and(
            eq(storedFiles.projectId, projectId),
            inArray(storedFiles.id, [...uniqueAttachmentIds].sort()),
          )).for("update");
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
      // job-wake 等系统回注不要抢线程标题
      const isSystem = isInternalSystemChatMessage({ text: trimmed, externalId });
      const titleSource = trimmed || attachments[0]?.originalFilename || "新对话";
      await tx
        .update(chatThreads)
        .set({
          title: !isSystem && thread.title === "新对话"
            ? titleSource.replace(/\s+/g, " ").slice(0, 28)
            : thread.title,
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

  /** H7：把 LangSmith root id 写回 chat_runs，便于对照本地 run。 */
  async setSmithRunId(runId: string, smithRunId: string) {
    await this.db
      .update(chatRuns)
      .set({ smithRunId })
      .where(eq(chatRuns.id, runId));
  }

  /** 工具开始：插入 chat_tool_calls 行（onConflictDoNothing 用于重放）。 */
  async startToolCall(runId: string, toolCallId: string, toolName: string, args: unknown) {
    const [created] = await this.db
      .insert(chatToolCalls)
      .values({ runId, toolCallId, toolName, args })
      .onConflictDoNothing({ target: [chatToolCalls.runId, chatToolCalls.toolCallId] })
      .returning();
    return created ? toToolCallDto(created) : undefined;
  }

  /**
   * 工具结束：upsert 同一 (runId, toolCallId) 行，标 succeeded/failed 写 result/error/cost。
   * error 截断 2000 字符防爆库。
   */
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

  /** prompt 正常返回后扫一遍：run 是否有 failed 工具 → run 标 failed，否则 completed。 */
  async summarizeRunTools(runId: string): Promise<{ status: "completed" | "failed"; error?: string }> {
    const rows = await this.db
      .select({
        status: chatToolCalls.status,
        error: chatToolCalls.error,
        toolName: chatToolCalls.toolName,
      })
      .from(chatToolCalls)
      .where(eq(chatToolCalls.runId, runId));
    const failed = rows.find((row) => row.status === "failed");
    if (!failed) return { status: "completed" };
    return {
      status: "failed",
      error: failed.error?.trim() || `${failed.toolName} 失败`,
    };
  }

  /**
   * 收尾：把 run 标 stopped/completed/failed，并把该 run 下所有 still-running tool_calls 一起结束。
   * 一次事务内做完，状态机不允许 run=stopped 时仍有 tool=runnning。
   */
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

  /**
   * 用户主动停当前 thread 上「我拥有」的 running run（前端 stop 按钮调用）。
   * 只动本实例的 run，不会去打扰其他实例仍在执行的任务。
   */
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

  /**
   * 私有：仅清理超时 running run（按 startedAt，不按 ownerId）。
   * 多实例部署下 owner 不等不等于已死；误 interrupt 会杀活任务。
   */
  private async interruptStaleRuns(projectId: string, threadId: string) {
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    await this.db.transaction(async (tx) => {
      const interrupted = await tx
        .update(chatRuns)
        .set({ status: "interrupted", error: "任务超时自动清理", finishedAt: new Date() })
        .where(and(
          eq(chatRuns.projectId, projectId),
          eq(chatRuns.threadId, threadId),
          eq(chatRuns.status, "running"),
          lt(chatRuns.startedAt, staleBefore),
        ))
        .returning({ id: chatRuns.id });
      if (interrupted.length > 0) {
        await tx
          .update(chatToolCalls)
          .set({ status: "interrupted", error: "任务超时自动清理", finishedAt: new Date() })
          .where(and(inArray(chatToolCalls.runId, interrupted.map((run) => run.id)), eq(chatToolCalls.status, "running")));
      }
    });
  }

  /**
   * 拉对话历史：消息按 sequence 升序，并把 run 状态注入为「虚拟 assistant 消息」
   * （status 文案由 runStatusMessage 生成，前端不用单独处理 run 状态）。
   * 一次往返：消息 + 未完结的 run + 100 条最近 tool calls。
   */
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

  /** 给 Agent 提供最近 N 条消息的可读文本（注入到 system prompt 的对话背景段）。 */
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
