import type { WebSocket } from "ws";
import type { ChatService } from "../services/chat-service.js";
import type { EventSink, ServerEvent } from "./events.js";
import type { AgentSessionRegistry } from "./session-registry.js";

type ClientMessage =
  | { type: "prompt"; text: string; threadId?: string; clientMessageId?: string }
  | { type: "stop"; threadId: string };

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
    try {
      const message = JSON.parse(raw) as ClientMessage;
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
      if (message.type !== "prompt" || !message.text.trim()) throw new Error("无效的聊天消息");
      const thread = await this.chats.resolveThread(projectId, message.threadId);
      await this.sessions.ensure(projectId, thread.id);
      const saved = await this.chats.appendPrompt(
        projectId,
        thread.id,
        message.text,
        message.clientMessageId ? `client:${projectId}:${message.clientMessageId}` : undefined,
      );
      this.emit({ type: "chat_message", projectId, message: saved.message });
      if (saved.created && saved.run) {
        try {
          await this.sessions.prompt(projectId, thread.id, saved.message.text, saved.run.id);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "聊天处理失败";
          const status = this.stopping.has(`${projectId}:${thread.id}`) ? "stopped" : "failed";
          const statusMessage = await this.chats.finishRun(saved.run.id, status, status === "failed" ? errorMessage : undefined);
          if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
          else if (status === "failed") this.send(socket, { type: "error", message: errorMessage });
          return;
        }
        await this.chats.finishRun(saved.run.id, "completed");
      }
    } catch (error) {
      this.send(socket, { type: "error", message: error instanceof Error ? error.message : "聊天处理失败" });
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
}
