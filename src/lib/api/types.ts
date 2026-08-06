export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  directionTitle?: string;
  effectCount: number;
  adoptedCount: number;
  coverUrl?: string;
}

export interface StoredFile {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  url: string;
}

export interface ChatAttachment {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  position: number;
}

export interface ArtifactSnapshot {
  id: string;
  artifactType: "space_map" | "understanding_note" | "design_directions" | "effect_image" | "proposal_package";
  versionId: string;
  versionNo: number;
  status: "draft" | "confirmed";
  payload: Record<string, unknown>;
  createdBy: "designer" | "agent";
}

export interface DeskLayoutObject {
  artifact_id: string;
  kind: string;
  x: number;
  y: number;
  rot: number;
  w?: number;
}

export interface DeskSnapshot {
  project: { id: string; name: string };
  artifacts: ArtifactSnapshot[];
  deskState: { objects: DeskLayoutObject[]; viewport: { x: number; y: number; zoom: number } };
}

export interface StoredChatMessage {
  id: string;
  threadId: string;
  projectId: string;
  role: "user" | "assistant";
  text: string;
  attachments: ChatAttachment[];
  createdAt: string;
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredToolCall {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  args: unknown;
  result?: unknown;
  error?: string;
  cost?: unknown;
  startedAt: string;
  finishedAt?: string;
}

export type ServerEvent =
  | { type: "agent_event"; event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; toolCallId?: string; isError?: boolean; projectId?: string; threadId?: string } }
  | { type: "agent_stopped"; projectId: string; threadId: string; stopped: boolean }
  | { type: "prompt_ack"; projectId: string; threadId: string; clientMessageId?: string; message: StoredChatMessage }
  | { type: "chat_message"; projectId: string; message: StoredChatMessage }
  | { type: "object_changed"; artifactId?: string; undoable?: boolean }
  | { type: "error"; clientMessageId?: string; error: { code: string; message: string; retryable: boolean; details?: unknown } };

export type ChatConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
