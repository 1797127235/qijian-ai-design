import type { ChatMessageDto } from "../services/chat-service.js";

export interface ServerErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type ServerEvent =
  | { type: "agent_event"; event: unknown }
  | { type: "agent_stopped"; projectId: string; threadId: string; stopped: boolean }
  | { type: "prompt_ack"; projectId: string; threadId: string; clientMessageId?: string; message: ChatMessageDto }
  | { type: "chat_message"; projectId: string; message: ChatMessageDto }
  | { type: "object_changed"; projectId: string; artifactId?: string; undoable?: boolean }
  | {
    type: "agent_job_updated";
    projectId: string;
    taskId: string;
    kind: string;
    status: string;
    artifactId?: string;
    error?: string;
  }
  | { type: "error"; projectId?: string; clientMessageId?: string; error: ServerErrorPayload };

export type EventSink = (event: ServerEvent) => void;
