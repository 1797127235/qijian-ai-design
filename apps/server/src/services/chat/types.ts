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
  /** 幂等键；job-wake:* 为系统回注，前端不应当用户气泡展示 */
  externalId?: string;
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
    ...(row.externalId ? { externalId: row.externalId } : {}),
  };
}

/** 异步 job 回注：协议上是 user 角色喂模型，产品 UI 必须隐藏。 */
export function isInternalSystemChatMessage(
  message: Pick<ChatMessageDto, "text" | "externalId"> | { text: string; externalId?: string | null },
): boolean {
  if (typeof message.externalId === "string" && message.externalId.startsWith("job-wake:")) return true;
  const text = (message.text ?? "").replace(/^\uFEFF/, "").trimStart();
  return text.includes("[JOB_EVENT]")
    || text.includes("[系统事件")
    || text.startsWith("source=agent_job");
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

/** 客户端可见工具载荷：只保留安全摘要，避免原样泄露 provider/路径细节。 */
function clientSafeToolPayload(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ["status", "task_id", "artifact_id", "kind", "connection_id", "error_code", "prompt", "source_artifact_id"]) {
      if (key in obj) {
        const v = obj[key];
        summary[key] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
      }
    }
    if (Object.keys(summary).length > 0) return summary;
    return { type: "object", keys: Object.keys(obj).slice(0, 12) };
  }
  return String(value);
}

function clientSafeError(error?: string | null): string | undefined {
  if (!error) return undefined;
  if (/取消|超时|中断|已停止|未找到|校验|无效|不能为空/.test(error)) return error.slice(0, 200);
  return "任务执行失败";
}

/** row → DTO（客户端安全）。 */
export function toToolCallDto(row: typeof chatToolCalls.$inferSelect): ChatToolCallDto {
  return {
    id: row.id,
    runId: row.runId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    status: row.status,
    args: clientSafeToolPayload(row.args),
    result: row.result == null ? undefined : clientSafeToolPayload(row.result),
    error: clientSafeError(row.error),
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
  let text: string | undefined;
  if (run.status === "interrupted") {
    text = "上一次任务因服务重启或异常退出而中断。为避免重复修改画布，系统没有自动重试；你可以重新发送这条要求。";
  } else if (run.status === "stopped") {
    text = "任务已停止。";
  } else if (run.status === "failed") {
    text = `任务执行失败：${clientSafeError(run.error) ?? "未知错误"}`;
  }
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
