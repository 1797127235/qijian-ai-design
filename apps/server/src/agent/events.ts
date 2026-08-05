import type { ChatMessageDto } from "../services/chat-service.js";

export type ServerEvent =
  | { type: "agent_event"; event: unknown }
  | { type: "agent_stopped"; projectId: string; threadId: string; stopped: boolean }
  | { type: "chat_message"; projectId: string; message: ChatMessageDto }
  | { type: "object_changed"; projectId: string; artifactId?: string; undoable?: boolean }
  | { type: "error"; projectId?: string; message: string };

export type EventSink = (event: ServerEvent) => void;
