/**
 * 工厂：拼一个 pi AgentSession。
 *
 *  - 模型：ModelRuntime 单例，懒加载；用 config.agentProvider/agentModel 选
 *  - 资源加载器：禁用 extensions/skills/promptTemplates/contextFiles（与文件无交叉污染）
 *  - SessionManager.continueRecent：进程内续历史（每个 projectId:threadId 一个目录）
 *  - 工具：customTools 全量注册；tools 传全部工具名作 allowlist（pi SDK 语义）；
 *    create 后 applyToolActivation 收窄到 base（search_tools + look_*）
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
import type { AgentJobStore } from "./async-job/store.js";
import {
  EventWriteTracker,
  assistantTextFromEvent,
  isToolExecutionEvent,
  persistToolEvent,
} from "./agent-event-persister.js";
import type { EventSink } from "./events.js";
import { agentSessionDir } from "./session-paths.js";
import { deskIdentityPrompt } from "./system-prompt.js";
import { applyToolActivation, createDeskTools, narrowBaseTools } from "./tools/index.js";
import type { TraceRegistry } from "./tracing/index.js";
import type { AssetTaskSubmissionService } from "../tasks/asset-task-submission.js";
import type { TaskCancellationService } from "../tasks/cancellation.js";
import type { ProjectMemoryService } from "./memory/service.js";
import { capJson, mapErrorFromUnknown } from "./tracing/index.js";
import {
  addUsageSample,
  emptyUsageAggregate,
  formatUsageLogLine,
  isUsageLogEnabled,
  sampleFromMessageEndEvent,
} from "./usage-metrics.js";

function requireNames(haystack: string[], required: string[], message: string): void {
  for (const name of required) {
    if (!haystack.includes(name)) throw new Error(`${message}：${name}`);
  }
}

export interface SessionFactoryDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  generate: CanvasGenerateService;
  chats: ChatService;
  files: FileStorage;
  emit: EventSink;
  config: Pick<ServerConfig, "agentProvider" | "agentModel" | "imageModelOptions">;
  assetTaskSubmitter?: AssetTaskSubmissionService;
  taskCancellation?: TaskCancellationService;
  jobStore?: AgentJobStore;
  captions?: ImageCaptionStore;
  traces?: TraceRegistry;
  memory?: ProjectMemoryService;
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
    const identity = deskIdentityPrompt({
      agentProvider: this.deps.config.agentProvider,
      agentModel: this.deps.config.agentModel,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: identity,
    });
    await loader.reload();
    this.modelRuntime ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.deps.config.agentProvider, this.deps.config.agentModel);
    if (!model) throw new Error(`未找到 Agent 模型：${this.deps.config.agentProvider}/${this.deps.config.agentModel}`);
    const sessionManager = SessionManager.continueRecent(cwd, agentSessionDir(projectId, threadId));
    // createDeskTools 闭包在 createAgentSession 之后才能拿到 session；用可变盒注入
    const sessionBox: { current?: AgentSession } = {};
    const deskTools = createDeskTools(
      projectId,
      {
        artifacts: this.deps.artifacts,
        desks: this.deps.desks,
        effects: this.deps.effects,
        generate: this.deps.generate,
        files: this.deps.files,
        emit: this.deps.emit,
        jobStore: this.deps.jobStore,
        taskCancellation: this.deps.taskCancellation,
        imageModelOptions: this.deps.config.imageModelOptions,
        assetTaskSubmitter: this.deps.assetTaskSubmitter,
        memory: this.deps.memory,
      },
      () => this.selectionBySession.get(key) ?? [],
      {
        threadId,
        runId: () => this.activeRunIds.get(key)?.[0],
      },
      {
        agentSession: () => sessionBox.current,
        identityPrompt: () => identity,
      },
    );
    const baseTools = narrowBaseTools();
    // pi SDK: options.tools = allowlist ∩ 初始 active。必须列入全部 desk 工具名，
    // 否则 setActiveToolsByName 无法激活 search 到的 custom 工具（静默忽略）。
    // 窄 base 仅靠 create 后 applyToolActivation 收紧。
    const allToolNames = deskTools.map((tool) => tool.name);
    requireNames(allToolNames, baseTools, "deskTools 缺少窄 base 工具");
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      tools: allToolNames,
      customTools: deskTools,
      thinkingLevel: "medium",
    });
    sessionBox.current = session;
    const activeAfterCreate = applyToolActivation(session, baseTools, identity);
    requireNames(activeAfterCreate, baseTools, "create 后未能激活窄 base 工具（检查 pi tools allowlist）");
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
      // model.turn + usage/cache 采集（L1 日志 / L2 span+root）
      if (event && typeof event === "object") {
        const et = (event as { type?: string }).type;
        if (ctx && et === "message_start" && (event as { message?: { role?: string } }).message?.role === "assistant") {
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
        if (et === "message_end") {
          const sample = sampleFromMessageEndEvent(event);
          if (sample) {
            if (ctx) {
              ctx.usageTotals = addUsageSample(
                ctx.usageTotals ?? emptyUsageAggregate(),
                sample,
              );
            }
            if (isUsageLogEnabled()) {
              console.info(formatUsageLogLine({
                projectId,
                threadId,
                runId,
                model: `${this.deps.config.agentProvider}/${this.deps.config.agentModel}`,
                sample,
                aggregate: ctx?.usageTotals,
              }));
            }
          }
          if (ctx?.modelSpan) {
            traces!.end(ctx.modelSpan, {
              status: "ok",
              outputs: sample ? { usage: sample } : undefined,
            });
            ctx.modelSpan = undefined;
          }
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
