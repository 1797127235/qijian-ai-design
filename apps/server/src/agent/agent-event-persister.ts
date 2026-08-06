import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatService } from "../services/chat-service.js";
import type { EventSink } from "./events.js";

type ToolExecutionEvent = Extract<AgentSessionEvent, {
  type: "tool_execution_start" | "tool_execution_end";
}>;

export function isToolExecutionEvent(event: AgentSessionEvent): event is ToolExecutionEvent {
  return event.type === "tool_execution_start" || event.type === "tool_execution_end";
}

export function jsonSnapshot(value: unknown, maxCharacters = 250_000): unknown {
  try {
    const serialized = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null";
    if (serialized.length <= maxCharacters) return JSON.parse(serialized) as unknown;
    return { truncated: true, preview: serialized.slice(0, maxCharacters), originalCharacters: serialized.length };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : "无法序列化工具数据" };
  }
}

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

function resultCost(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const direct = (details as { cost?: unknown }).cost;
  if (direct !== undefined) return jsonSnapshot(direct);
  const usage = (details as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? jsonSnapshot((usage as { cost?: unknown }).cost) : undefined;
}

export async function persistToolEvent(
  chats: Pick<ChatService, "startToolCall" | "finishToolCall">,
  runId: string,
  event: ToolExecutionEvent,
) {
  if (event.type === "tool_execution_start") {
    await chats.startToolCall(runId, event.toolCallId, event.toolName, jsonSnapshot(event.args));
    return;
  }
  await chats.finishToolCall(
    runId,
    event.toolCallId,
    event.toolName,
    jsonSnapshot(event.result),
    event.isError,
    event.isError ? resultError(event.result) : undefined,
    resultCost(event.result),
  );
}

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

/** 跟踪一次 agent run 的异步写库，prompt 结束前可 await。 */
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
