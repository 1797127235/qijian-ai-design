/**
 * 工厂：拼一个 pi AgentSession。
 *
 *  - 模型：ModelRuntime 单例，懒加载；用 config.agentProvider/agentModel 选
 *  - 资源加载器：禁用 extensions/skills/promptTemplates/contextFiles（与文件无交叉污染）
 *  - SessionManager.continueRecent：进程内续历史（每个 projectId:threadId 一个目录）
 *  - 工具：白名单 generate_from_desk + get_task + look_at_desk + look_at（可选 debug_return_image）
 *  - 订阅：每条事件透传给 emit；工具执行事件入 EventWriteTracker 持久化；assistant 文本入 chat
 */
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
import type { CanvasGenerateService } from "../services/canvas-generate-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ImageGenerator } from "../services/image-generator.js";
import type { ChatService } from "../services/chat-service.js";
import type { FileStorage } from "../services/file-storage.js";
import type { ImageCaptionStore } from "../services/image-caption-store.js";
import type { AgentJobRunner } from "./async-job/runner.js";
import type { AgentJobStore } from "./async-job/store.js";
import {
  EventWriteTracker,
  assistantTextFromEvent,
  isToolExecutionEvent,
  persistToolEvent,
} from "./agent-event-persister.js";
import type { EventSink } from "./events.js";
import { agentSessionDir } from "./session-paths.js";
import { deskSystemPrompt } from "./system-prompt.js";
import { createDeskTools } from "./tools/index.js";
import type { TraceRegistry } from "./tracing/index.js";
import { capJson, mapErrorFromUnknown } from "./tracing/index.js";

export interface SessionFactoryDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  generate: CanvasGenerateService;
  chats: ChatService;
  files: FileStorage;
  emit: EventSink;
  config: Pick<ServerConfig, "agentProvider" | "agentModel" | "imageModelOptions">;
  jobs?: AgentJobRunner;
  jobStore?: AgentJobStore;
  captions?: ImageCaptionStore;
  traces?: TraceRegistry;
}

export class SessionFactory {
  private modelRuntime?: Promise<ModelRuntime>;

  constructor(
    private readonly deps: SessionFactoryDependencies,
    private readonly writes: EventWriteTracker,
    private readonly activeRunIds: Map<string, string[]>,
    /** 本轮 prompt 选中，按 projectId:threadId 读写 */
    private readonly selectionBySession: Map<string, string[]>,
  ) {}

  loadAgentImages(projectId: string, attachments: Parameters<FileStorage["loadAgentImages"]>[1]) {
    return this.deps.files.loadAgentImages(projectId, attachments);
  }

  /**
   * 创建一个 pi AgentSession。
   *  - modelRuntime 进程内单例（首次调用 init 后续复用）
   *  - 每个 (projectId, threadId) 一个 session 目录，continueRecent 自动 resume
   *  - 订阅：所有事件 fan-out 给 emit；工具执行事件入 tracker 异步写库；assistant 文本入 chat
   */
  async create(projectId: string, threadId: string): Promise<AgentSession> {
    const key = `${projectId}:${threadId}`;
    const cwd = process.cwd();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: deskSystemPrompt({
        agentProvider: this.deps.config.agentProvider,
        agentModel: this.deps.config.agentModel,
      }),
    });
    await loader.reload();
    this.modelRuntime ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.deps.config.agentProvider, this.deps.config.agentModel);
    if (!model) throw new Error(`未找到 Agent 模型：${this.deps.config.agentProvider}/${this.deps.config.agentModel}`);
    const sessionManager = SessionManager.continueRecent(cwd, agentSessionDir(projectId, threadId));
    const deskTools = createDeskTools(
      projectId,
      {
        artifacts: this.deps.artifacts,
        desks: this.deps.desks,
        effects: this.deps.effects,
        generate: this.deps.generate,
        files: this.deps.files,
        emit: this.deps.emit,
        jobs: this.deps.jobs,
        jobStore: this.deps.jobStore,
        imageModelOptions: this.deps.config.imageModelOptions,
      },
      () => this.selectionBySession.get(key) ?? [],
      {
        threadId,
        runId: () => this.activeRunIds.get(key)?.[0],
      },
    );
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      tools: deskTools.map((tool) => tool.name),
      customTools: deskTools,
      thinkingLevel: "medium",
    });
    session.subscribe((event) => {
      this.deps.emit({ type: "agent_event", event: { projectId, threadId, ...event } });
      // H7: 用入口捕获的 run_id（队头仍是当前轮；span 侧不依赖 [0] 以外语义）
      const runId = this.activeRunIds.get(key)?.[0];
      const traces = this.deps.traces;
      const ctx = traces?.get(runId);
      if (runId && isToolExecutionEvent(event)) {
        if (event.type === "tool_execution_start" && ctx) {
          const span = traces!.startSpan(runId, {
            name: `tool.${event.toolName}`,
            run_type: "tool",
            inputs: capJson(event.args) as Record<string, unknown>,
            metadata: { tool_call_id: event.toolCallId, tool_name: event.toolName },
          });
          if (span) ctx.toolSpans.set(event.toolCallId, span);
        }
        if (event.type === "tool_execution_end" && ctx) {
          const span = ctx.toolSpans.get(event.toolCallId);
          const failed = event.isError || (event.result && typeof event.result === "object"
            && (event.result as { details?: { ok?: boolean } }).details?.ok === false);
          if (span) {
            if (failed) {
              traces!.recordError(span, mapErrorFromUnknown(
                (event.result as { details?: { error?: string } })?.details?.error
                  ?? "tool failed",
                { aborted: false },
              ));
            } else {
              traces!.end(span, {
                status: "ok",
                outputs: capJson(event.result) as Record<string, unknown>,
              });
            }
            ctx.toolSpans.delete(event.toolCallId);
          }
        }
        this.writes.track(projectId, persistToolEvent(this.deps.chats, runId, event), runId);
      }
      // model.turn：message_start / message_end 粗粒度
      if (ctx && event && typeof event === "object") {
        const et = (event as { type?: string }).type;
        if (et === "message_start" && (event as { message?: { role?: string } }).message?.role === "assistant") {
          if (!ctx.modelSpan) {
            ctx.modelSpan = traces!.startSpan(runId, {
              name: "model.turn",
              run_type: "llm",
              metadata: {
                model: `${this.deps.config.agentProvider}/${this.deps.config.agentModel}`,
              },
            });
          }
        }
        if (et === "message_end" && ctx.modelSpan) {
          traces!.end(ctx.modelSpan, { status: "ok" });
          ctx.modelSpan = undefined;
        }
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
