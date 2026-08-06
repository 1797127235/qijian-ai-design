import type { WebSocket } from "ws";
import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../domain/attachment-limits.js";
import { AppError } from "../lib/errors.js";
import type { ChatService } from "../services/chat-service.js";
import type { EventSink, ServerEvent } from "./events.js";
import type { AgentSessionRegistry } from "./session-registry.js";

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    text: z.string().max(20_000).default(""),
    threadId: z.string().min(1).optional(),
    clientMessageId: z.string().min(1).max(200).optional(),
    attachmentIds: z.array(z.string().min(1)).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
    // 方案 1：选中随本条 prompt 携带，不单独推 selection 事件；max 1 对齐画布单选
    selectedArtifactIds: z.array(z.string().min(1)).max(1).default([]),
  }).refine((message) => message.text.trim().length > 0 || message.attachmentIds.length > 0, {
    // 仅选中不算可发送内容，避免空聊；有字或附件才进模型
    message: "消息或附件至少需要一项",
  }),
  z.object({ type: z.literal("stop"), threadId: z.string().min(1) }),
]);

export class ChatGateway {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly stopping = new Set<string>();
  readonly emit: EventSink = (event) => this.broadcastEvent(event);

  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly chats: ChatService,
  ) {}

  connect(projectId: string, socket: WebSocket) {
    const group = this.clients.get(projectId) ?? new Set<WebSocket>();
    group.add(socket);
    this.clients.set(projectId, group);
    this.send(socket, { type: "agent_event", event: { type: "connected", projectId } });
    socket.on("message", (raw) => void this.receive(projectId, socket, raw.toString()));
    socket.on("close", () => {
      group.delete(socket);
      if (group.size === 0) this.clients.delete(projectId);
    });
  }

  private async receive(projectId: string, socket: WebSocket, raw: string) {
    let clientMessageId: string | undefined;
    try {
      const decoded = JSON.parse(raw) as unknown;
      if (decoded && typeof decoded === "object" && typeof (decoded as { clientMessageId?: unknown }).clientMessageId === "string") {
        clientMessageId = (decoded as { clientMessageId: string }).clientMessageId;
      }
      const message = clientMessageSchema.parse(decoded);
      if (message.type === "stop") {
        const thread = await this.chats.resolveThread(projectId, message.threadId);
        const key = `${projectId}:${thread.id}`;
        this.stopping.add(key);
        try {
          const stopped = await this.sessions.stop(projectId, thread.id);
          if (stopped) {
            for (const statusMessage of await this.chats.finishRunningRuns(projectId, thread.id, "stopped")) {
              this.emit({ type: "chat_message", projectId, message: statusMessage });
            }
          }
          this.emit({ type: "agent_stopped", projectId, threadId: thread.id, stopped });
        } finally {
          this.stopping.delete(key);
        }
        return;
      }
      if (message.type !== "prompt") throw new Error("无效的聊天消息");
      const thread = await this.chats.resolveThread(projectId, message.threadId);
      await this.sessions.ensure(projectId, thread.id);
      const saved = await this.chats.appendPrompt(
        projectId,
        thread.id,
        message.text,
        message.clientMessageId ? `client:${projectId}:${message.clientMessageId}` : undefined,
        message.attachmentIds,
      );
      this.send(socket, {
        type: "prompt_ack",
        projectId,
        threadId: thread.id,
        clientMessageId: message.clientMessageId,
        message: saved.message,
      });
      this.emit({ type: "chat_message", projectId, message: saved.message });
      if (saved.created && saved.run) {
        try {
          // appendPrompt 只落用户原文；selected 与状态栏仅进当轮 session.prompt
          await this.sessions.prompt(
            projectId,
            thread.id,
            saved.message.text,
            saved.message.attachments,
            saved.run.id,
            message.selectedArtifactIds,
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "聊天处理失败";
          const status = this.stopping.has(`${projectId}:${thread.id}`) ? "stopped" : "failed";
          const statusMessage = await this.chats.finishRun(saved.run.id, status, status === "failed" ? errorMessage : undefined);
          if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
          else if (status === "failed") this.sendError(socket, error);
          return;
        }
        await this.chats.finishRun(saved.run.id, "completed");
      }
    } catch (error) {
      this.sendError(socket, error, clientMessageId);
    }
  }

  private broadcastEvent(event: ServerEvent) {
    const projectId = event.type === "agent_event"
      ? (event.event as { projectId?: string }).projectId
      : "projectId" in event ? event.projectId : undefined;
    if (!projectId) return;
    for (const socket of this.clients.get(projectId) ?? []) this.send(socket, event);
  }

  private send(socket: WebSocket, event: ServerEvent) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  private sendError(socket: WebSocket, error: unknown, clientMessageId?: string) {
    const appError = error instanceof AppError
      ? error
      : error instanceof z.ZodError
        ? new AppError(
            422,
            "VALIDATION_FAILED",
            error.issues[0]?.message ?? "聊天消息格式无效",
            false,
            error.issues,
          )
      : new AppError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "聊天处理失败", true);
    this.send(socket, {
      type: "error",
      clientMessageId,
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        details: appError.details,
      },
    });
  }
}
