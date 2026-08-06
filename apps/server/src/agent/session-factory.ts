import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "../config.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ExportService } from "../services/export-service.js";
import type { ImageGenerator } from "../services/image-generator.js";
import type { ChatService } from "../services/chat-service.js";
import type { FileStorage } from "../services/file-storage.js";
import {
  EventWriteTracker,
  assistantTextFromEvent,
  isToolExecutionEvent,
  persistToolEvent,
} from "./agent-event-persister.js";
import type { EventSink } from "./events.js";
import { loadHistoricalVisuals, restoreChatMessages } from "./session-restore.js";
import { deskSystemPrompt } from "./system-prompt.js";
import { createDeskTools } from "./tools/index.js";

export interface SessionFactoryDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  exports: ExportService;
  chats: ChatService;
  files: FileStorage;
  emit: EventSink;
  config: Pick<ServerConfig, "agentProvider" | "agentModel">;
}

export class SessionFactory {
  private modelRuntime?: Promise<ModelRuntime>;

  constructor(
    private readonly deps: SessionFactoryDependencies,
    private readonly writes: EventWriteTracker,
    private readonly activeRunIds: Map<string, string[]>,
  ) {}

  loadAgentImages(projectId: string, attachments: Parameters<FileStorage["loadAgentImages"]>[1]) {
    return this.deps.files.loadAgentImages(projectId, attachments);
  }

  async create(projectId: string, threadId: string): Promise<AgentSession> {
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
        this.writes.track(projectId, persistToolEvent(this.deps.chats, runId, event), runId);
      }
      const text = assistantTextFromEvent(event);
      if (!text) return;
      this.writes.track(projectId, this.deps.chats
        .append(projectId, threadId, "assistant", text, undefined, runId)
        .then(({ message }) => this.deps.emit({ type: "chat_message", projectId, message }))
        .then(() => undefined), runId);
    });
    return session;
  }
}
