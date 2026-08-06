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
