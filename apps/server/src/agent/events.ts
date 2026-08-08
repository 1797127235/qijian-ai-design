/**
 * 服务端事件类型：所有从 server → client 的消息都通过 ChatGateway.broadcastEvent 走 WS。
 *
 * 设计原则：
 *  - 携带 projectId 用于在 ChatGateway 做 fan-out（不同 project 的连接互不干扰）
 *  - agent_event 是 pi 原始事件透传，加 projectId/threadId 元信息
 *  - prompt_ack 单独出来：明确告诉前端「这条 user 消息服务端已收」
 *  - object_changed 标记桌面物件变化（含 Agent 写桌），TODO 3 把它接上 refetch
 */
import type { ChatMessageDto } from "../services/chat-service.js";

/** 错误事件的机器可读 payload；前端按 code 分支，message 仅展示。 */
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
  /** 项目被改名（目前由自动起名触发）；前端就地更新顶栏/列表 */
  | { type: "project_renamed"; projectId: string; name: string }
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
