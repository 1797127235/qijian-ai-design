import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { chatMessages, chatRuns, chatThreads, chatToolCalls } from "../db/schema.js";

export type ChatRole = "user" | "assistant";

export interface ChatMessageDto {
  id: string;
  threadId: string;
  projectId: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

export interface ChatThreadDto {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface ChatRunDto {
  id: string;
  threadId: string;
  projectId: string;
  userMessageId: string;
  status: ChatRunStatus;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type ChatToolCallStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface ChatToolCallDto {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  status: ChatToolCallStatus;
  args: unknown;
  result?: unknown;
  error?: string;
  cost?: unknown;
  startedAt: string;
  finishedAt?: string;
}

function toDto(row: typeof chatMessages.$inferSelect): ChatMessageDto {
  return {
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    role: row.role,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

function toThreadDto(row: typeof chatThreads.$inferSelect): ChatThreadDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunDto(row: typeof chatRuns.$inferSelect): ChatRunDto {
  return {
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    userMessageId: row.userMessageId,
    status: row.status,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

function toToolCallDto(row: typeof chatToolCalls.$inferSelect): ChatToolCallDto {
  return {
    id: row.id,
    runId: row.runId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    status: row.status,
    args: row.args,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    cost: row.cost ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export function runStatusMessage(run: ChatRunDto): ChatMessageDto | undefined {
  const text = run.status === "interrupted"
    ? "上一次任务因服务重启或异常退出而中断。为避免重复修改画布，系统没有自动重试；你可以重新发送这条要求。"
    : run.status === "stopped"
      ? "任务已停止。"
      : run.status === "failed"
        ? `任务执行失败：${run.error ?? "未知错误"}`
        : undefined;
  if (!text) return undefined;
  return {
    id: `run-status:${run.id}`,
    threadId: run.threadId,
    projectId: run.projectId,
    role: "assistant",
    text,
    createdAt: run.finishedAt ?? run.startedAt,
  };
}

export function formatChatContext(
  messages: Array<Pick<ChatMessageDto, "role" | "text">>,
  maxCharacters = 30_000,
): string {
  const lines = messages.map((message) => `${message.role === "user" ? "设计师" : "设计助手"}：${message.text}`);
  const selected: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (length + line.length > maxCharacters && selected.length > 0) break;
    selected.unshift(line.slice(Math.max(0, line.length - maxCharacters)));
    length += line.length;
  }
  return selected.join("\n\n");
}

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
    await this.resolveThread(projectId);
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

  async append(
    projectId: string,
    threadId: string,
    role: ChatRole,
    text: string,
    externalId?: string,
  ): Promise<{ message: ChatMessageDto; created: boolean }> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("聊天消息不能为空");

    if (externalId) {
      const [existing] = await this.db.select().from(chatMessages).where(eq(chatMessages.externalId, externalId));
      if (existing) return { message: toDto(existing), created: false };
    }

    const thread = await this.resolveThread(projectId, threadId);
    const [created] = externalId
      ? await this.db
          .insert(chatMessages)
          .values({ threadId: thread.id, projectId, role, text: trimmed, externalId })
          .onConflictDoNothing({ target: chatMessages.externalId })
          .returning()
      : await this.db
          .insert(chatMessages)
          .values({ threadId: thread.id, projectId, role, text: trimmed })
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
      return { message: toDto(created), created: true };
    }
    const [existing] = await this.db.select().from(chatMessages).where(eq(chatMessages.externalId, externalId!));
    if (!existing) throw new Error("聊天消息保存失败");
    return { message: toDto(existing), created: false };
  }

  async appendPrompt(
    projectId: string,
    threadId: string,
    text: string,
    externalId?: string,
  ): Promise<{ message: ChatMessageDto; run?: ChatRunDto; created: boolean }> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("聊天消息不能为空");

    return this.db.transaction(async (tx) => {
      if (externalId) {
        const [existing] = await tx.select().from(chatMessages).where(eq(chatMessages.externalId, externalId));
        if (existing) return { message: toDto(existing), created: false };
      }
      const [thread] = await tx
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId)));
      if (!thread) throw new Error("对话不存在或不属于当前项目");
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
        return { message: toDto(existing), created: false };
      }
      const now = new Date();
      await tx
        .update(chatThreads)
        .set({
          title: thread.title === "新对话" ? trimmed.replace(/\s+/g, " ").slice(0, 28) : thread.title,
          updatedAt: now,
        })
        .where(eq(chatThreads.id, thread.id));
      const [run] = await tx
        .insert(chatRuns)
        .values({ projectId, threadId, userMessageId: message.id, ownerId: this.instanceId })
        .returning();
      return { message: toDto(message), run: toRunDto(run), created: true };
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
    const statusByMessage = new Map(runs.map((run) => [run.userMessageId, runStatusMessage(toRunDto(run))]));
    const messages = rows.flatMap((row) => {
      const message = toDto(row);
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
    return rows.reverse().map(toDto);
  }
}
