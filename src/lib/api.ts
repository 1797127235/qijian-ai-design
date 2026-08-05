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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as {
      error?: string | { code?: string; message?: string; retryable?: boolean; details?: unknown };
    } | undefined;
    const payload = typeof body?.error === "string" ? { message: body.error } : body?.error;
    throw new ApiError(payload?.message ?? `请求失败（${response.status}）`, payload?.code, payload?.retryable, payload?.details);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  listProjects: () => request<ProjectSummary[]>("/api/projects"),
  createProject: (name: string) => request<ProjectSummary>("/api/projects", json("POST", { name })),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  desk: (projectId: string) => request<DeskSnapshot>(`/api/projects/${projectId}/desk`),
  chatThreads: (projectId: string) => request<ChatThread[]>(`/api/projects/${projectId}/chat/threads`),
  createChatThread: (projectId: string) =>
    request<ChatThread>(`/api/projects/${projectId}/chat/threads`, json("POST", {})),
  deleteChatThread: (projectId: string, threadId: string) =>
    request<void>(`/api/projects/${projectId}/chat/threads/${threadId}`, { method: "DELETE" }),
  chatHistory: (projectId: string, threadId: string) =>
    request<{ threadId: string; messages: StoredChatMessage[]; toolCalls: StoredToolCall[] }>(
      `/api/projects/${projectId}/chat/messages?threadId=${encodeURIComponent(threadId)}`,
    ),
  moveObject: (projectId: string, artifactId: string, patch: { x?: number; y?: number; rot?: number }) =>
    request<DeskLayoutObject>(`/api/projects/${projectId}/desk/objects/${artifactId}`, json("PATCH", patch)),
  setViewport: (projectId: string, viewport: { x: number; y: number; zoom: number }) =>
    request<{ viewport: DeskSnapshot["deskState"]["viewport"] }>(`/api/projects/${projectId}/desk`, json("PATCH", { viewport })),
  createArtifact: (projectId: string, input: { artifactType: ArtifactSnapshot["artifactType"]; payload: Record<string, unknown>; inputRefs?: unknown[]; status?: "draft" | "confirmed"; layout?: { kind: string; x: number; y: number; rot?: number; w?: number } }) =>
    request<{ artifact: { id: string } }>(`/api/projects/${projectId}/artifacts`, json("POST", input)),
  appendVersion: (artifactId: string, payload: Record<string, unknown>, inputRefs?: unknown[]) =>
    request<{ versionNo: number }>(`/api/artifacts/${artifactId}/versions`, json("POST", { payload, ...(inputRefs ? { inputRefs } : {}) })),
  confirmArtifact: (artifactId: string) => request(`/api/artifacts/${artifactId}/confirm`, json("POST", {})),
  rollbackArtifact: (artifactId: string, versionId?: string) =>
    request<{ versionNo: number }>(`/api/artifacts/${artifactId}/rollback`, json("POST", versionId ? { versionId } : {})),
  exportPackage: (projectId: string) =>
    request<{ artifactId: string; pdfUrl?: string; imageUrls?: string[] }>(`/api/projects/${projectId}/export`, json("POST", {})),
  uploadFile: async (projectId: string, file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append("file", file);
    return request<StoredFile>(`/api/projects/${projectId}/files`, { method: "POST", body: form, signal });
  },
  deleteFile: (projectId: string, fileId: string) =>
    request<void>(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),
  fileUrl: (fileId: string) => `/api/files/${fileId}`,
};

export type ServerEvent =
  | { type: "agent_event"; event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; toolCallId?: string; isError?: boolean; projectId?: string; threadId?: string } }
  | { type: "agent_stopped"; projectId: string; threadId: string; stopped: boolean }
  | { type: "prompt_ack"; projectId: string; threadId: string; clientMessageId?: string; message: StoredChatMessage }
  | { type: "chat_message"; projectId: string; message: StoredChatMessage }
  | { type: "object_changed"; artifactId?: string; undoable?: boolean }
  | { type: "error"; clientMessageId?: string; error: { code: string; message: string; retryable: boolean; details?: unknown } };

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

export type ChatConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export function connectChat(
  projectId: string,
  onEvent: (event: ServerEvent) => void,
  onStatus?: (status: ChatConnectionStatus) => void,
) {
  const url = new URL(`/api/projects/${projectId}/chat`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let closed = false;
  let status: ChatConnectionStatus = "connecting";
  const queue: string[] = [];

  const updateStatus = (next: ChatConnectionStatus) => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  const connect = () => {
    if (closed) return;
    updateStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.onopen = () => {
      reconnectAttempt = 0;
      updateStatus("connected");
      for (const message of queue.splice(0)) nextSocket.send(message);
    };
    nextSocket.onmessage = (raw) => {
      try {
        onEvent(JSON.parse(raw.data as string) as ServerEvent);
      } catch {
        onEvent({ type: "error", error: { code: "INVALID_SERVER_EVENT", message: "收到无法解析的助手消息", retryable: true } });
      }
    };
    nextSocket.onerror = () => {
      // close 事件负责统一进入重连流程，避免重复提示。
    };
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = undefined;
      if (closed) {
        updateStatus("disconnected");
        return;
      }
      reconnectAttempt += 1;
      updateStatus("reconnecting");
      const delay = Math.min(500 * 2 ** (reconnectAttempt - 1), 5_000);
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  const send = (message: object) => {
    const serialized = JSON.stringify(message);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(serialized);
      return true;
    }
    if (queue.length >= 20) {
      onEvent({ type: "error", error: { code: "SEND_QUEUE_FULL", message: "待发送消息过多，请等待连接恢复", retryable: true } });
      return false;
    }
    queue.push(serialized);
    return true;
  };

  onStatus?.(status);
  connect();

  return {
    prompt: (text: string, threadId: string, clientMessageId?: string, attachmentIds: string[] = []) => send({
      type: "prompt",
      text,
      threadId,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
    stop: (threadId: string) => send({ type: "stop", threadId }),
    close: () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      queue.length = 0;
      socket?.close();
      socket = undefined;
      updateStatus("disconnected");
    },
    ready: () => socket?.readyState === WebSocket.OPEN,
    status: () => status,
  };
}
