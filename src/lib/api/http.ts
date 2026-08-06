import {
  ApiError,
  type ArtifactSnapshot,
  type ChatThread,
  type DeskLayoutObject,
  type DeskSnapshot,
  type ProjectSummary,
  type StoredChatMessage,
  type StoredFile,
  type StoredToolCall,
} from "./types";

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
  moveObject: (projectId: string, artifactId: string, patch: { x?: number; y?: number; rot?: number; w?: number }) =>
    request<DeskLayoutObject>(`/api/projects/${projectId}/desk/objects/${artifactId}`, json("PATCH", patch)),
  deleteObject: (projectId: string, artifactId: string) =>
    request<{ object: DeskLayoutObject }>(`/api/projects/${projectId}/desk/objects/${artifactId}`, { method: "DELETE" }),
  setViewport: (projectId: string, viewport: { x: number; y: number; zoom: number }) =>
    request<{ viewport: DeskSnapshot["deskState"]["viewport"] }>(`/api/projects/${projectId}/desk`, json("PATCH", { viewport })),
  createConnection: (projectId: string, input: { from: string; to: string; clientOpId?: string; connectionId?: string }) =>
    request<{ connection: { id: string; from: string; to: string } }>(`/api/projects/${projectId}/desk/connections`, json("POST", input)),
  deleteConnection: (projectId: string, connectionId: string) =>
    request<{ connection: { id: string; from: string; to: string } }>(`/api/projects/${projectId}/desk/connections/${connectionId}`, { method: "DELETE" }),
  generateImage: (projectId: string, input: {
    prompt: string;
    sourceArtifactId: string;
    clientOpId: string;
    /** 重试时传入失败卡 id，服务端在原卡上重跑 */
    targetArtifactId?: string;
  }) =>
    request<{
      artifact: { id: string };
      connection: { id: string; from: string; to: string };
      status: "pending" | "succeeded" | "failed";
      error?: string;
    }>(`/api/projects/${projectId}/generate-image`, json("POST", input)),
  createArtifact: (projectId: string, input: { artifactType: ArtifactSnapshot["artifactType"]; payload: Record<string, unknown>; inputRefs?: unknown[]; status?: "draft" | "confirmed"; artifactId?: string; clientOpId?: string; layout?: { kind: string; x: number; y: number; rot?: number; w?: number } }) =>
    request<{ artifact: { id: string }; version: { id: string }; object?: DeskLayoutObject }>(`/api/projects/${projectId}/artifacts`, json("POST", input)),
  appendVersion: (artifactId: string, payload: Record<string, unknown>, inputRefs?: unknown[]) =>
    request<{ versionNo: number }>(`/api/artifacts/${artifactId}/versions`, json("POST", { payload, ...(inputRefs ? { inputRefs } : {}) })),
  rollbackArtifact: (artifactId: string, versionId?: string) =>
    request<{ versionNo: number }>(`/api/artifacts/${artifactId}/rollback`, json("POST", versionId ? { versionId } : {})),
  uploadFile: async (projectId: string, file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append("file", file);
    return request<StoredFile>(`/api/projects/${projectId}/files`, { method: "POST", body: form, signal });
  },
  deleteFile: (projectId: string, fileId: string) =>
    request<void>(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),
  fileUrl: (fileId: string) => `/api/files/${fileId}`,
};
