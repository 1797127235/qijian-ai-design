// API 层 DTO 类型定义：与后端返回结构一一对应
// 字段命名注意：DeskLayoutObject 沿用后端 snake_case（artifact_id），其余 camel_case

// 项目列表卡片：首页/侧边栏展示用
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  /** 人看封面（server 预渲染桌面拼板）；null = 未渲染/无 ready 图，前端回退空骨架 */
  coverFileId: string | null;
}

// 已上传文件元数据，含可直接访问的 url
export interface StoredFile {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number; // 多页文件（如 PDF）才有
  url: string;
}

// 聊天消息中的附件：比 StoredFile 多了 position 用于渲染顺序
export interface ChatAttachment {
  id: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  position: number;
}

// 画布对象的内容快照
// artifactType：画布图片 / 效果图
// payload 是 Record<string, unknown>，具体结构由 src/desk/map.ts 解释
export interface ArtifactSnapshot {
  id: string;
  artifactType: "canvas_image" | "effect_image";
  versionId: string;
  versionNo: number;
  status: "draft" | "confirmed"; // 草稿 / 已确认
  payload: Record<string, unknown>;
  inputRefs: unknown[]; // 产生该 artifact 的输入引用（如来源文件）
  createdBy: "designer" | "agent"; // 设计师手动 / Agent 生成
}

// 画布上某个 artifact 的布局（位置 + 旋转 + 宽度）
// 字段为 snake_case，对应后端直出
export interface DeskLayoutObject {
  artifact_id: string;
  kind: string;
  x: number;
  y: number;
  rot: number;
  w?: number;
}

export interface DeskConnectionDto {
  id: string;
  from: string;
  to: string;
}

// 一整张"桌子"的完整快照：项目元信息 + 所有 artifacts + 画布布局（含视口）
export interface DeskSnapshot {
  project: { id: string; name: string };
  artifacts: ArtifactSnapshot[];
  deskState: {
    objects: DeskLayoutObject[];
    connections: DeskConnectionDto[];
    viewport: { x: number; y: number; zoom: number };
  };
}

// 单条聊天消息记录
export interface StoredChatMessage {
  id: string;
  threadId: string;
  projectId: string;
  role: "user" | "assistant";
  text: string;
  attachments: ChatAttachment[];
  createdAt: string;
  /** job-wake:* 等系统回注；前端不展示为用户气泡 */
  externalId?: string;
}

/** 异步 job wake 等内部消息：协议上是 user，UI 必须隐藏。 */
export function isInternalSystemChatMessage(
  message: Pick<StoredChatMessage, "text" | "externalId"> | { text: string; externalId?: string | null },
): boolean {
  if (typeof message.externalId === "string" && message.externalId.startsWith("job-wake:")) return true;
  const text = (message.text ?? "").replace(/^\uFEFF/, "").trimStart();
  return text.includes("[JOB_EVENT]")
    || text.includes("[系统事件")
    || text.startsWith("source=agent_job");
}

// 聊天会话线程
export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// Agent 工具调用记录
export interface StoredToolCall {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  args: unknown;
  result?: unknown;
  error?: string;
  cost?: unknown; // 调用开销（token/费用等）
  startedAt: string;
  finishedAt?: string;
}

// 服务端推送事件（SSE）的判别联合，按 type 字段分发
// 注意：除已标注字段外，projectId/threadId/artifactId 等大量 optional，消费时要容错
export type ServerEvent =
  // Agent 流式事件：包含文本增量（delta）、工具调用、错误标志等
  | { type: "agent_event"; event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; toolCallId?: string; isError?: boolean; projectId?: string; threadId?: string } }
  // Agent 停止（正常完成或中断）
  | { type: "agent_stopped"; projectId: string; threadId: string; stopped: boolean }
  // 用户提交消息的回执：带回完整消息对象，用于本地立刻渲染
  | { type: "prompt_ack"; projectId: string; threadId: string; clientMessageId?: string; message: StoredChatMessage }
  // 新聊天消息广播
  | { type: "chat_message"; projectId: string; message: StoredChatMessage }
  // 画布对象变更：触发画布重渲染；undoable 提示是否可撤销
  | { type: "object_changed"; artifactId?: string; undoable?: boolean }
  // 项目被改名（自动起名触发）；就地更新顶栏/列表
  | { type: "project_renamed"; name: string }
  // Agent 异步 job 状态（受理/运行/终态）；桌面仍以 object_changed 刷新为主
  | {
    type: "agent_job_updated";
    projectId?: string;
    taskId: string;
    kind: string;
    status: string;
    artifactId?: string;
    error?: string;
  }
  // 错误事件：retryable 决定前端是否自动重试
  | { type: "error"; clientMessageId?: string; error: { code: string; message: string; retryable: boolean; details?: unknown } };

// SSE 连接状态机
export type ChatConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

// 自定义 API 错误：带 code / retryable / details，便于前端按策略处理
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
