import type { WebSocket } from "ws";
import type { EventSink, ServerEvent } from "./events.js";
import type { PermissionGate } from "./permission-gate.js";
import type { AgentSessionRegistry } from "./session-registry.js";

type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "approval_response"; approvalId: string; approved: boolean };

export class ChatGateway {
  private readonly clients = new Map<string, Set<WebSocket>>();
  readonly emit: EventSink = (event) => this.broadcastEvent(event);

  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly gate: PermissionGate,
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
      if (message.type === "approval_response") {
        if (!this.gate.resolve(projectId, message.approvalId, message.approved)) throw new Error("审批请求已失效");
        return;
      }
      if (message.type !== "prompt" || !message.text.trim()) throw new Error("无效的聊天消息");
      await this.sessions.prompt(projectId, message.text.trim());
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
