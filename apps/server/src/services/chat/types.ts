import { chatMessages, chatRuns, chatThreads, chatToolCalls } from "../../db/schema.js";

export type ChatRole = "user" | "assistant";

export interface ChatMessageDto {
  id: string;
  threadId: string;
  projectId: string;
  role: ChatRole;
  text: string;
  attachments: ChatAttachmentDto[];
  createdAt: string;
}

export interface ChatAttachmentDto {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  position: number;
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

export function toMessageDto(row: typeof chatMessages.$inferSelect, attachments: ChatAttachmentDto[] = []): ChatMessageDto {
  return {
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    role: row.role,
    text: row.text,
    attachments,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toThreadDto(row: typeof chatThreads.$inferSelect): ChatThreadDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRunDto(row: typeof chatRuns.$inferSelect): ChatRunDto {
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

export function toToolCallDto(row: typeof chatToolCalls.$inferSelect): ChatToolCallDto {
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
    attachments: [],
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
