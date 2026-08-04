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
import type { EventSink } from "./events.js";
import type { PermissionGate } from "./permission-gate.js";
import { deskSystemPrompt } from "./system-prompt.js";
import { createDeskTools } from "./tools/index.js";

interface RegistryDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  exports: ExportService;
  gate: PermissionGate;
  emit: EventSink;
  config: Pick<ServerConfig, "agentProvider" | "agentModel">;
}

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private modelRuntime?: Promise<ModelRuntime>;

  constructor(private readonly deps: RegistryDependencies) {}

  async prompt(projectId: string, text: string) {
    const session = await this.get(projectId);
    await session.prompt(text, { source: "interactive", streamingBehavior: session.isStreaming ? "followUp" : undefined });
  }

  private get(projectId: string) {
    let session = this.sessions.get(projectId);
    if (!session) {
      session = this.create(projectId).catch((error) => {
        this.sessions.delete(projectId);
        throw error;
      });
      this.sessions.set(projectId, session);
    }
    return session;
  }

  private async create(projectId: string) {
    const snapshot = await this.deps.desks.snapshot(projectId);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: deskSystemPrompt(snapshot),
    });
    await loader.reload();
    this.modelRuntime ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.deps.config.agentProvider, this.deps.config.agentModel);
    if (!model) throw new Error(`未找到 Agent 模型：${this.deps.config.agentProvider}/${this.deps.config.agentModel}`);
    const { session } = await createAgentSession({
      modelRuntime,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      noTools: "builtin",
      customTools: createDeskTools(projectId, this.deps),
    });
    session.subscribe((event) => this.deps.emit({ type: "agent_event", event: { projectId, ...event } }));
    return session;
  }
}
