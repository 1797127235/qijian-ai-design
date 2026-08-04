export type PermissionMode = "ask" | "auto";

export interface ProjectSummary {
  id: string;
  name: string;
  permission: PermissionMode;
  updatedAt: string;
  briefExcerpt?: string;
  briefStatus?: "draft" | "confirmed";
  directionTitle?: string;
  effectCount: number;
  adoptedCount: number;
  coverUrl?: string;
}

export interface StoredFile {
  id: string;
  originalFilename: string;
  mediaType: string;
}

export interface ArtifactSnapshot {
  id: string;
  artifactType: "design_brief" | "space_map" | "understanding_note" | "design_directions" | "effect_image" | "proposal_package";
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
  project: { id: string; name: string; permission: PermissionMode };
  artifacts: ArtifactSnapshot[];
  deskState: { objects: DeskLayoutObject[]; viewport: { x: number; y: number; zoom: number } };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
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
  moveObject: (projectId: string, artifactId: string, patch: { x?: number; y?: number; rot?: number }) =>
    request<DeskLayoutObject>(`/api/projects/${projectId}/desk/objects/${artifactId}`, json("PATCH", patch)),
  setViewport: (projectId: string, viewport: { x: number; y: number; zoom: number }) =>
    request<{ viewport: DeskSnapshot["deskState"]["viewport"] }>(`/api/projects/${projectId}/desk`, json("PATCH", { viewport })),
  createArtifact: (projectId: string, input: { artifactType: ArtifactSnapshot["artifactType"]; payload: Record<string, unknown>; status?: "draft" | "confirmed"; layout?: { kind: string; x: number; y: number; rot?: number; w?: number } }) =>
    request<{ artifact: { id: string } }>(`/api/projects/${projectId}/artifacts`, json("POST", input)),
  appendVersion: (artifactId: string, payload: Record<string, unknown>) =>
    request<{ versionNo: number }>(`/api/artifacts/${artifactId}/versions`, json("POST", { payload })),
  confirmArtifact: (artifactId: string) => request(`/api/artifacts/${artifactId}/confirm`, json("POST", {})),
  setPermission: (projectId: string, permission: PermissionMode) =>
    request<{ permission: PermissionMode }>(`/api/projects/${projectId}/permission`, json("PUT", { permission })),
  exportPackage: (projectId: string) =>
    request<{ artifactId: string; pdfUrl?: string; imageUrls?: string[] }>(`/api/projects/${projectId}/export`, json("POST", {})),
  uploadFile: async (projectId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<StoredFile>(`/api/projects/${projectId}/files`, { method: "POST", body: form });
  },
  fileUrl: (fileId: string) => `/api/files/${fileId}`,
};

export type ServerEvent =
  | { type: "agent_event"; event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; isError?: boolean; projectId?: string } }
  | { type: "approval_request"; approvalId: string; tool: string; description: string }
  | { type: "approval_resolved"; approvalId: string; approved: boolean }
  | { type: "object_changed"; artifactId?: string }
  | { type: "error"; message: string };

export function connectChat(projectId: string, onEvent: (event: ServerEvent) => void) {
  const url = new URL(`/api/projects/${projectId}/chat`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.onmessage = (raw) => {
    try {
      onEvent(JSON.parse(raw.data as string) as ServerEvent);
    } catch {
      // 忽略无法解析的消息
    }
  };
  return {
    prompt: (text: string) => socket.send(JSON.stringify({ type: "prompt", text })),
    respondApproval: (approvalId: string, approved: boolean) =>
      socket.send(JSON.stringify({ type: "approval_response", approvalId, approved })),
    close: () => socket.close(),
    ready: () => socket.readyState === socket.OPEN,
  };
}
