import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "../config.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ExportService } from "../services/export-service.js";
import type { ImageGenerator } from "../services/image-generator.js";
import type { ChatAttachmentDto, ChatMessageDto, ChatService } from "../services/chat-service.js";
import type { AgentImageContent, FileStorage } from "../services/file-storage.js";
import type { EventSink } from "./events.js";
import { deskSystemPrompt } from "./system-prompt.js";
import { createDeskTools } from "./tools/index.js";

interface RegistryDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  exports: ExportService;
  chats: ChatService;
  files: FileStorage;
  emit: EventSink;
  config: Pick<ServerConfig, "agentProvider" | "agentModel">;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_RESTORED_AGENT_IMAGES = 12;
const MAX_RESTORED_AGENT_BASE64_CHARACTERS = 24 * 1024 * 1024;

type RestoredVisuals = Map<string, { images: AgentImageContent[]; unavailable: string[] }>;

export async function loadHistoricalVisuals(
  projectId: string,
  messages: ChatMessageDto[],
  files: Pick<FileStorage, "loadAgentImages">,
  limits = {
    maxImages: MAX_RESTORED_AGENT_IMAGES,
    maxBase64Characters: MAX_RESTORED_AGENT_BASE64_CHARACTERS,
  },
): Promise<RestoredVisuals> {
  const restored = new Map<string, { images: AgentImageContent[]; unavailable: string[] }>();
  let remainingImages = limits.maxImages;
  let remainingCharacters = limits.maxBase64Characters;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || message.attachments.length === 0) continue;
    const images: AgentImageContent[] = [];
    const unavailable: string[] = [];
    for (const attachment of message.attachments) {
      if (remainingImages === 0 || remainingCharacters === 0) {
        unavailable.push(attachment.originalFilename);
        continue;
      }
      try {
        const loaded = await files.loadAgentImages(projectId, [attachment]);
        const characterCount = loaded.reduce((total, image) => total + image.data.length, 0);
        if (loaded.length > remainingImages || characterCount > remainingCharacters) {
          unavailable.push(attachment.originalFilename);
          continue;
        }
        images.push(...loaded);
        remainingImages -= loaded.length;
        remainingCharacters -= characterCount;
      } catch {
        unavailable.push(attachment.originalFilename);
      }
    }
    restored.set(message.id, { images, unavailable });
  }
  return restored;
}

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRunIds = new Map<string, string[]>();
  private readonly eventWrites = new Set<Promise<void>>();
  private readonly runWrites = new Map<string, Set<Promise<void>>>();
  private readonly runWriteErrors = new Map<string, unknown>();
  private modelRuntime?: Promise<ModelRuntime>;
  private shuttingDown = false;

  constructor(
    private readonly deps: RegistryDependencies,
    private readonly idleTimeoutMs = DEFAULT_SESSION_IDLE_MS,
  ) {}

  async prompt(projectId: string, threadId: string, text: string, attachments: ChatAttachmentDto[], runId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.get(projectId, threadId);
    const session = await pending;
    const activeRuns = this.activeRunIds.get(key) ?? [];
    activeRuns.push(runId);
    this.activeRunIds.set(key, activeRuns);
    try {
      const images = await this.deps.files.loadAgentImages(projectId, attachments);
      await session.prompt(agentPrompt(text, attachments), {
        images,
        source: "interactive",
        streamingBehavior: session.isStreaming ? "followUp" : undefined,
      });
      await this.awaitRunWrites(runId);
    } finally {
      const index = activeRuns.indexOf(runId);
      if (index >= 0) activeRuns.splice(index, 1);
      if (activeRuns.length === 0) this.activeRunIds.delete(key);
      this.scheduleIdle(key, pending);
    }
  }

  async ensure(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.get(projectId, threadId);
    await pending;
    this.scheduleIdle(key, pending);
  }

  async stop(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.sessions.get(key);
    if (!pending) return false;
    try {
      return await stopAgentSession(await pending);
    } finally {
      this.scheduleIdle(key, pending);
    }
  }

  async forget(projectId: string, threadId: string) {
    const pending = this.take(`${projectId}:${threadId}`);
    if (!pending) return false;
    await releaseAgentSession(await pending, true);
    return true;
  }

  async forgetProject(projectId: string) {
    const prefix = `${projectId}:`;
    const pending = [...this.sessions.keys()]
      .filter((key) => key.startsWith(prefix))
      .flatMap((key) => {
        const session = this.take(key);
        return session ? [session] : [];
      });
    await Promise.allSettled(pending.map(async (session) => releaseAgentSession(await session, true)));
    return pending.length;
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (session) => releaseAgentSession(await session, true)));
    await Promise.allSettled([...this.eventWrites]);
  }

  private get(projectId: string, threadId: string) {
    if (this.shuttingDown) throw new Error("Agent 服务正在关闭");
    const key = `${projectId}:${threadId}`;
    this.clearIdle(key);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.create(projectId, threadId).catch((error) => {
        this.sessions.delete(key);
        throw error;
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  private take(key: string) {
    this.clearIdle(key);
    this.activeRunIds.delete(key);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    return pending;
  }

  private clearIdle(key: string) {
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
  }

  private scheduleIdle(key: string, pending: Promise<AgentSession>) {
    if (this.shuttingDown || this.sessions.get(key) !== pending) return;
    this.clearIdle(key);
    const timer = setTimeout(() => void this.evictIdle(key, pending, timer), this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  private async evictIdle(key: string, pending: Promise<AgentSession>, timer: ReturnType<typeof setTimeout>) {
    if (this.idleTimers.get(key) !== timer || this.sessions.get(key) !== pending) return;
    const session = await pending.catch(() => undefined);
    if (this.idleTimers.get(key) !== timer || this.sessions.get(key) !== pending) return;
    if (session?.isStreaming) {
      this.scheduleIdle(key, pending);
      return;
    }
    this.take(key);
    session?.dispose();
  }

  private async create(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const recentMessages = await this.deps.chats.recentMessages(projectId, threadId);
    const restoredVisuals = await loadHistoricalVisuals(projectId, recentMessages, this.deps.files);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: deskSystemPrompt(),
    });
    await loader.reload();
    this.modelRuntime ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.deps.config.agentProvider, this.deps.config.agentModel);
    if (!model) throw new Error(`未找到 Agent 模型：${this.deps.config.agentProvider}/${this.deps.config.agentModel}`);
    const sessionManager = SessionManager.inMemory();
    restoreChatMessages(sessionManager, recentMessages, model, restoredVisuals);
    const { session } = await createAgentSession({
      modelRuntime,
      model,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      noTools: "builtin",
      customTools: createDeskTools(projectId, this.deps),
    });
    session.subscribe((event) => {
      this.deps.emit({ type: "agent_event", event: { projectId, threadId, ...event } });
      const runId = this.activeRunIds.get(key)?.[0];
      if (runId && isToolExecutionEvent(event)) {
        this.trackEventWrite(projectId, persistToolEvent(this.deps.chats, runId, event), runId);
      }
      const text = assistantTextFromEvent(event);
      if (!text) return;
      this.trackEventWrite(projectId, this.deps.chats
        .append(projectId, threadId, "assistant", text, undefined, runId)
        .then(({ message }) => this.deps.emit({ type: "chat_message", projectId, message }))
        .then(() => undefined), runId);
    });
    return session;
  }

  private trackEventWrite(projectId: string, pending: Promise<void>, runId?: string) {
    const tracked = pending
      .catch((error) => {
        if (runId) this.runWriteErrors.set(runId, error);
        this.deps.emit({
          type: "error",
          projectId,
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? `运行记录保存失败：${error.message}` : "运行记录保存失败",
            retryable: true,
          },
        });
      })
      .finally(() => {
        this.eventWrites.delete(tracked);
        if (runId) {
          const writes = this.runWrites.get(runId);
          writes?.delete(tracked);
          if (writes?.size === 0) this.runWrites.delete(runId);
        }
      });
    this.eventWrites.add(tracked);
    if (runId) {
      const writes = this.runWrites.get(runId) ?? new Set<Promise<void>>();
      writes.add(tracked);
      this.runWrites.set(runId, writes);
    }
  }

  private async awaitRunWrites(runId: string) {
    while (this.runWrites.get(runId)?.size) {
      await Promise.all([...this.runWrites.get(runId)!]);
    }
    const error = this.runWriteErrors.get(runId);
    this.runWriteErrors.delete(runId);
    if (error) throw error;
  }
}

type ToolExecutionEvent = Extract<AgentSessionEvent, {
  type: "tool_execution_start" | "tool_execution_end";
}>;

function isToolExecutionEvent(event: AgentSessionEvent): event is ToolExecutionEvent {
  return event.type === "tool_execution_start" || event.type === "tool_execution_end";
}

export function jsonSnapshot(value: unknown, maxCharacters = 250_000): unknown {
  try {
    const serialized = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null";
    if (serialized.length <= maxCharacters) return JSON.parse(serialized) as unknown;
    return { truncated: true, preview: serialized.slice(0, maxCharacters), originalCharacters: serialized.length };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : "无法序列化工具数据" };
  }
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : [])
    .join("\n")
    .trim();
  return text || undefined;
}

function resultCost(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const direct = (details as { cost?: unknown }).cost;
  if (direct !== undefined) return jsonSnapshot(direct);
  const usage = (details as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? jsonSnapshot((usage as { cost?: unknown }).cost) : undefined;
}

export async function persistToolEvent(
  chats: Pick<ChatService, "startToolCall" | "finishToolCall">,
  runId: string,
  event: ToolExecutionEvent,
) {
  if (event.type === "tool_execution_start") {
    await chats.startToolCall(runId, event.toolCallId, event.toolName, jsonSnapshot(event.args));
    return;
  }
  await chats.finishToolCall(
    runId,
    event.toolCallId,
    event.toolName,
    jsonSnapshot(event.result),
    event.isError,
    event.isError ? resultError(event.result) : undefined,
    resultCost(event.result),
  );
}

type RestoredModelIdentity = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function restoreChatMessages(
  sessionManager: SessionManager,
  messages: Array<Pick<ChatMessageDto, "role" | "text" | "createdAt"> & { id?: string; attachments?: ChatAttachmentDto[] }>,
  model: RestoredModelIdentity,
  restoredVisuals = new Map<string, { images: AgentImageContent[]; unavailable: string[] }>(),
) {
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt) || Date.now();
    if (message.role === "user") {
      const attachments = message.attachments ?? [];
      const restored = message.id ? restoredVisuals.get(message.id) : undefined;
      const text = restored?.unavailable.length
        ? `${agentPrompt(message.text, attachments)}\n\n[以下历史附件当前不可用：${restored.unavailable.join("、")}]`
        : agentPrompt(message.text, attachments);
      const content = restored?.images.length
        ? [{ type: "text" as const, text }, ...restored.images]
        : text;
      sessionManager.appendMessage({ role: "user", content, timestamp });
      continue;
    }
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
  }
}

export function agentPrompt(text: string, attachments: ChatAttachmentDto[]) {
  const base = text.trim() || "请分析这些附件，并根据当前项目上下文继续设计。";
  if (attachments.length === 0) return base;
  const list = attachments.map((attachment) => {
    const pageNote = attachment.mediaType === "application/pdf"
      ? `，PDF ${attachment.pageCount ?? "未知"} 页${(attachment.pageCount ?? 0) > 8 ? "，本次提供前 8 页视觉内容" : ""}`
      : "";
    return `- ${attachment.originalFilename}${pageNote} [source_file_id: ${attachment.id}]`;
  }).join("\n");
  return `${base}\n\n本条消息附件：\n${list}`;
}

export async function stopAgentSession(session: Pick<AgentSession, "isStreaming" | "abort"> | undefined) {
  if (!session?.isStreaming) return false;
  await session.abort();
  return true;
}

export async function releaseAgentSession(
  session: Pick<AgentSession, "isStreaming" | "abort" | "dispose">,
  abortActive: boolean,
) {
  try {
    if (abortActive && session.isStreaming) await session.abort();
  } finally {
    session.dispose();
  }
}

export function assistantTextFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message_end") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}
