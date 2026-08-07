/**
 * Agent 事件 → DB 持久化工具。
 *
 *  - 工具开始/结束事件：写 chat_tool_calls
 *  - assistant 文本：从 message_end 抠出来写 chat_messages
 *  - 序列化（jsonSnapshot）处理 bigint + 超长截断
 *  - EventWriteTracker：跟踪一次 run 的所有异步写库，prompt 结束前 await 完
 *
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatService } from "../services/chat-service.js";
import type { EventSink } from "./events.js";
import { isToolBusinessFailure, toolFailureMessage } from "./tool-result.js";

type ToolExecutionEvent = Extract<AgentSessionEvent, {
  type: "tool_execution_start" | "tool_execution_end";
}>;

/** 类型守卫：是不是工具执行事件。 */
export function isToolExecutionEvent(event: AgentSessionEvent): event is ToolExecutionEvent {
  return event.type === "tool_execution_start" || event.type === "tool_execution_end";
}

/**
 * 序列化任意值入库：
 *  - bigint 变字符串（drizzle jsonb 不收 bigint）
 *  - 超 maxCharacters 截断，避免一条工具结果把整行撑爆
 *  - 循环引用 / 不可序列化对象降级为 {serializationError} 不抛
 */
export function jsonSnapshot(value: unknown, maxCharacters = 250_000): unknown {
  try {
    const serialized = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null";
    if (serialized.length <= maxCharacters) return JSON.parse(serialized) as unknown;
    return { truncated: true, preview: serialized.slice(0, maxCharacters), originalCharacters: serialized.length };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : "无法序列化工具数据" };
  }
}

/** 从工具 result.content[] 抠出文本（pi 工具结果结构：{content: [{type, text}, ...], details}）。 */
function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : [])
    .join("\n")
    .trim();
  return text || undefined;
}

/** 从 result.details.cost / result.details.usage.cost 抠 provider 报告的费用。 */
function resultCost(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const direct = (details as { cost?: unknown }).cost;
  if (direct !== undefined) return jsonSnapshot(direct);
  const usage = (details as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? jsonSnapshot((usage as { cost?: unknown }).cost) : undefined;
}

/**
 * 持久化单条工具执行事件。
 *  - start：插 chat_tool_calls 行（onConflictDoNothing 用于重放）
 *  - end：upsert 同一行，标 succeeded/failed；失败原因用 toolFailureMessage 优先，content 兜底
 */
export async function persistToolEvent(
  chats: Pick<ChatService, "startToolCall" | "finishToolCall">,
  runId: string,
  event: ToolExecutionEvent,
) {
  if (event.type === "tool_execution_start") {
    await chats.startToolCall(runId, event.toolCallId, event.toolName, jsonSnapshot(event.args));
    return;
  }
  // fail() 时 pi isError 常为 false，需按 details.ok / status 判业务失败
  const failed = isToolBusinessFailure(event.result, event.isError);
  await chats.finishToolCall(
    runId,
    event.toolCallId,
    event.toolName,
    jsonSnapshot(event.result),
    failed,
    failed ? (toolFailureMessage(event.result) ?? resultError(event.result)) : undefined,
    resultCost(event.result),
  );
}

/**
 * 从 message_end 抠出 assistant 文本。用于实时把 AI 回复写进 chat_messages。
 * content 可能是 string 也可能是 [{type:"text", text:"..."}, ...] 数组，都要支持。
 */
export function assistantTextFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message_end") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * 跟踪一次 agent run 的异步写库（不阻塞事件流）。
 *  - 每次 track 注入一个 pending promise + 可选 runId
 *  - awaitRun(runId)：等该 run 的所有写库结束；如有过错会 rethrow
 *  - drain()：所有写库（一般用于服务关停）
 *  - 写库失败会 emit type:"error" 给前端（前端可看到「运行记录保存失败」）
 */
export class EventWriteTracker {
  private readonly eventWrites = new Set<Promise<void>>();
  private readonly runWrites = new Map<string, Set<Promise<void>>>();
  private readonly runWriteErrors = new Map<string, unknown>();

  constructor(private readonly emit: EventSink) {}

  track(projectId: string, pending: Promise<void>, runId?: string) {
    const tracked = pending
      .catch((error) => {
        if (runId) this.runWriteErrors.set(runId, error);
        this.emit({
          type: "error",
          projectId,
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? `运行记录保存失败：${error.message}` : "运行记录保存失败",
            retryable: true,
          },
        });
      })
      .finally(() => {
        this.eventWrites.delete(tracked);
        if (runId) {
          const writes = this.runWrites.get(runId);
          writes?.delete(tracked);
          if (writes?.size === 0) this.runWrites.delete(runId);
        }
      });
    this.eventWrites.add(tracked);
    if (runId) {
      const writes = this.runWrites.get(runId) ?? new Set<Promise<void>>();
      writes.add(tracked);
      this.runWrites.set(runId, writes);
    }
  }

  async awaitRun(runId: string) {
    while (this.runWrites.get(runId)?.size) {
      await Promise.all([...this.runWrites.get(runId)!]);
    }
    const error = this.runWriteErrors.get(runId);
    this.runWriteErrors.delete(runId);
    if (error) throw error;
  }

  async drain() {
    await Promise.allSettled([...this.eventWrites]);
  }
}
