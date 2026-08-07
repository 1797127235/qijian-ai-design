/**
 * Chat DTO 类型 + 序列化器：把 DB row 转换成给前端的稳定契约。
 * 这里只放「与 schema 形状对齐，但 Date 变 ISO string」的无逻辑转换。
 * 真正业务（runStatusMessage 注入状态文案、formatChatContext 拼 prompt 上下文）也在本文件。
 */
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
  smithRunId?: string;
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

/** row → DTO：Date → ISO string。 */
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

/** row → DTO。 */
export function toThreadDto(row: typeof chatThreads.$inferSelect): ChatThreadDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** row → DTO。 */
export function toRunDto(row: typeof chatRuns.$inferSelect): ChatRunDto {
  return {
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    userMessageId: row.userMessageId,
    status: row.status,
    error: row.error ?? undefined,
    smithRunId: row.smithRunId ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

/** row → DTO。 */
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

/**
 * 把 run 状态翻译成一条「虚拟 assistant 消息」，注入 history 返回。
 * running 状态不发（避免消息列表滚个不停），interrupted/stopped/failed 三态发对应文案。
 * id 用 "run-status:{id}" 避免与真实 message.id 冲突。
 */
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

/**
 * 把 messages 序列化成 Agent system prompt 里用的「对话背景」字符串。
 *  - 中文标签「设计师/设计助手」便于 LLM 识别角色
 *  - 倒序遍历累加字符数，超 maxCharacters 截断最近的若干条（保留最新对话）
 */
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
