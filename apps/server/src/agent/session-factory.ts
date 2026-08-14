/**
 * 工厂：拼一个 pi AgentSession。
 *
 *  - 模型：ModelRuntime 单例，懒加载；用 config.agentProvider/agentModel 选
 *  - 资源加载器：禁用 extensions/skills/promptTemplates/contextFiles（与文件无交叉污染）
 *  - SessionManager.continueRecent：进程内续历史（每个 projectId:threadId 一个目录）
 *  - 工具：customTools 全量注册；tools 传全部工具名作 allowlist（pi SDK 语义）；
 *    create 后激活 Kernel（search_tools + look_* + read_context_resource）
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
  redactAgentEvent,
  redactToolResult,
} from "./agent-event-persister.js";
import type { EventSink } from "./events.js";
import { agentSessionDir } from "./session-paths.js";
import { deskSystemPrompt } from "./system-prompt.js";
import { activateTools, createDeskTools } from "./tools/index.js";
import type { TurnContextScope } from "./capability-gate.js";
import type { TraceRegistry } from "./tracing/index.js";
import type { AssetTaskSubmissionService } from "../tasks/asset-task-submission.js";
import type { TaskCancellationService } from "../tasks/cancellation.js";
import type { ProjectMemoryService } from "./memory/service.js";
import { capJson, mapErrorFromUnknown } from "./tracing/index.js";
import { dirname, join } from "node:path";
import {
  addUsageSample,
  emptyUsageAggregate,
  formatUsageLogLine,
  isUsageLogEnabled,
  sampleFromMessageEndEvent,
} from "./usage-metrics.js";
import { fingerprintAgentContext, sha256, type CacheFingerprint } from "./cache-contract.js";
import {
  SessionToolState,
  type SessionToolStateSnapshot,
} from "./tools/session-tool-state.js";
import {
  CurrentContextFrameState,
  type CurrentContextFrameInput,
  type PreparedCurrentContextFrame,
} from "./context/current-context-frame.js";
import { DeskAliasRegistry } from "./context/desk-alias-registry.js";
import { skillCatalogRevision } from "./skills/catalog.js";
import {
  SessionSkillState,
  type SessionSkillStateSnapshot,
} from "./skills/session-skill-state.js";
import {
  resolveExplicitSkills,
  type ExplicitSkillResolution,
} from "./skills/resolver.js";
import { ContextResourceStore } from "./context/resource-store.js";
import { resultBudgetOf } from "./tools/result-budget.js";
import {
  createToolBatchLedgerExtension,
  type ToolBatchLedgerReport,
} from "./context/tool-batch-ledger.js";
import type { RuntimeMetrics } from "../observability/metrics.js";
import { AgentTurnObservation, summarizePayload } from "./turn-observation.js";

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
  metrics?: RuntimeMetrics;
  memory?: ProjectMemoryService;
}

export class SessionFactory {
  private modelRuntime?: Promise<ModelRuntime>;
  private readonly requestFingerprints = new Map<string, CacheFingerprint>();
  private readonly toolStates = new WeakMap<AgentSession, SessionToolState>();
  private readonly skillStates = new WeakMap<AgentSession, SessionSkillState>();
  private readonly contextStates = new WeakMap<AgentSession, CurrentContextFrameState>();
  private readonly preparedFrames = new Map<string, PreparedCurrentContextFrame>();
  private readonly aliasRegistries = new Map<string, Promise<DeskAliasRegistry>>();

  constructor(
    private readonly deps: SessionFactoryDependencies,
    private readonly writes: EventWriteTracker,
    private readonly turnContext: TurnContextScope,
  ) {}

  loadAgentImages(projectId: string, attachments: Parameters<FileStorage["loadAgentImages"]>[1]) {
    return this.deps.files.loadAgentImages(projectId, attachments);
  }

  prepareToolBoundary(session: AgentSession): SessionToolStateSnapshot | undefined {
    const state = this.toolStates.get(session);
    if (!state) return undefined;
    const current = session.getActiveToolNames();
    if (state.needsBoundary(current)) {
      const active = activateTools(session, state.desiredActiveTools());
      state.recordBoundary(current, active);
    }
    return state.snapshot();
  }

  toolStateSnapshot(session: AgentSession): SessionToolStateSnapshot | undefined {
    return this.toolStates.get(session)?.snapshot();
  }

  skillStateSnapshot(session: AgentSession): SessionSkillStateSnapshot | undefined {
    return this.skillStates.get(session)?.snapshot();
  }

  markOpenWork(session: AgentSession): void {
    this.skillStates.get(session)?.markOpenWork();
  }

  closeOpenWork(session: AgentSession): void {
    this.skillStates.get(session)?.closeOpenWork();
  }

  noteResumeHop(session: AgentSession, maxHops: number): boolean {
    return this.skillStates.get(session)?.noteResumeHop(maxHops) ?? false;
  }

  resolveExplicitSkills(session: AgentSession, userText: string): ExplicitSkillResolution {
    const state = this.skillStates.get(session);
    if (!state) return { requestedIds: [], missingIds: [], injected: [] };
    return resolveExplicitSkills(userText, state);
  }

  forceSkillResync(session: AgentSession): void {
    this.skillStates.get(session)?.forceResync();
  }

  async flushToolState(session: AgentSession): Promise<void> {
    const state = this.toolStates.get(session);
    if (!state) return;
    try {
      await state.flush();
    } catch (error) {
      console.warn("[agent-tools] failed to persist session working set:", error instanceof Error ? error.message : error);
    }
  }

  async flushSkillState(session: AgentSession): Promise<void> {
    const state = this.skillStates.get(session);
    if (!state) return;
    try {
      await state.flush();
    } catch (error) {
      console.warn("[agent-skills] failed to persist session skill state:", error instanceof Error ? error.message : error);
    }
  }

  async prepareContextFrame(
    session: AgentSession,
    runId: string,
    input: CurrentContextFrameInput,
  ): Promise<PreparedCurrentContextFrame> {
    const state = this.contextStates.get(session);
    if (!state) throw new Error("context frame state is not attached to this session");
    const prepared = await state.prepare(input);
    this.preparedFrames.set(runId, prepared);
    return prepared;
  }

  commitContextFrame(session: AgentSession, prepared: PreparedCurrentContextFrame): void {
    const state = this.contextStates.get(session);
    if (!state) throw new Error("context frame state is not attached to this session");
    state.commit(prepared, sha256(session.messages));
  }

  async flushContextFrame(session: AgentSession): Promise<void> {
    const state = this.contextStates.get(session);
    if (!state) return;
    try {
      await state.flush();
    } catch (error) {
      console.warn("[agent-context] failed to persist context ledger:", error instanceof Error ? error.message : error);
    }
  }

  releaseRunContext(runId: string): void {
    this.requestFingerprints.delete(runId);
    this.preparedFrames.delete(runId);
  }

  markContextCompacted(session: AgentSession): void {
    this.contextStates.get(session)?.forceResync();
    this.skillStates.get(session)?.forceResync();
  }

  async deskAliases(projectId: string, artifactIds: readonly string[]): Promise<Record<string, string>> {
    const registry = this.aliasRegistries.get(projectId);
    if (!registry) throw new Error(`desk alias registry is not initialized for project ${projectId}`);
    return (await registry).assign(artifactIds);
  }

  async flushDeskAliases(projectId: string): Promise<void> {
    const registry = this.aliasRegistries.get(projectId);
    if (!registry) return;
    try {
      await (await registry).flush();
    } catch (error) {
      console.warn("[agent-context] failed to persist desk aliases:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * 创建一个 pi AgentSession。
   *  - modelRuntime 进程内单例（首次调用 init 后续复用）
   *  - 每个 (projectId, threadId) 一个 session 目录，continueRecent 自动 resume
   *  - 订阅：所有事件 fan-out 给 emit；工具执行事件入 tracker 异步写库；assistant 文本入 chat
   */
  async create(projectId: string, threadId: string): Promise<AgentSession> {
    const cwd = process.cwd();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
    const toolBatchLedgerReport: { current?: ToolBatchLedgerReport } = {};
    const systemPrompt = deskSystemPrompt({
      agentProvider: this.deps.config.agentProvider,
      agentModel: this.deps.config.agentModel,
    });
    const catalogRevision = skillCatalogRevision();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt,
      extensionFactories: [{
        name: "qijian-tool-batch-ledger",
        hidden: true,
        factory: createToolBatchLedgerExtension({
          onCompacted: (report) => {
            toolBatchLedgerReport.current = report;
          },
        }),
      }],
    });
    await loader.reload();
    this.modelRuntime ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.deps.config.agentProvider, this.deps.config.agentModel);
    if (!model) throw new Error(`未找到 Agent 模型：${this.deps.config.agentProvider}/${this.deps.config.agentModel}`);
    const observedModel = `${this.deps.config.agentProvider}/${this.deps.config.agentModel}`;
    const sessionDir = agentSessionDir(projectId, threadId);
    if (!this.aliasRegistries.has(projectId)) {
      this.aliasRegistries.set(
        projectId,
        DeskAliasRegistry.open(join(dirname(sessionDir), "desk-aliases.json")),
      );
    }
    await this.aliasRegistries.get(projectId);
    const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
    // createDeskTools 闭包在 createAgentSession 之后才能拿到 session；用可变盒注入
    const sessionBox: { current?: AgentSession } = {};
    const toolStateBox: { current?: SessionToolState } = {};
    const skillStateBox: { current?: SessionSkillState } = {};
    const resourceStore = new ContextResourceStore(join(sessionDir, "resources"));
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
      {
        threadId,
        turnContext: this.turnContext,
        agentSession: () => sessionBox.current,
        toolState: () => toolStateBox.current,
        skillState: () => skillStateBox.current,
        resourceStore,
      },
    );
    // 固定全量工具集：全部 desk 工具即 Kernel，创建时一次激活，运行路径
    // 不再调用 setActiveToolsByName（它会改变 tools[] 并让 pi 重建 system
    // prompt，缓存前缀从 system 段起整体失配——基准 r01 断点 #2）。
    // pi SDK: options.tools = allowlist ∩ 初始 active，与全量注册同名。
    const allToolNames = deskTools.map((tool) => tool.name);
    const registryRevision = sha256(deskTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
    })));
    const toolState = await SessionToolState.open({
      filePath: join(sessionDir, "tool-state.json"),
      registryNames: allToolNames,
      registryRevision,
      kernelNames: allToolNames,
    });
    const contextState = await CurrentContextFrameState.open({
      filePath: join(sessionDir, "context-ledger.json"),
      contextEpoch: sha256({ systemPrompt, catalogRevision }),
      resourceStore,
    });
    const skillState = await SessionSkillState.open({
      filePath: join(sessionDir, "skill-state.json"),
      catalogRevision,
    });
    toolStateBox.current = toolState;
    skillStateBox.current = skillState;
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
    const toolStartedAt = new Map<string, number>();
    const turnObservation = new AgentTurnObservation();
    const previousActive = toolState.snapshot().lastActiveTools;
    const activeAfterCreate = activateTools(session, toolState.desiredActiveTools());
    requireNames(activeAfterCreate, allToolNames, "create 后未能固定激活全量工具（检查 pi tools allowlist）");
    toolState.recordBoundary(previousActive, activeAfterCreate);
    this.toolStates.set(session, toolState);
    this.skillStates.set(session, skillState);
    this.contextStates.set(session, contextState);
    if (!contextState.validateTrajectory(sha256(session.messages))) skillState.forceResync();
    await this.flushToolState(session);
    await this.flushSkillState(session);
    await this.flushContextFrame(session);
    session.subscribe((event) => {
      const publicEvent = redactAgentEvent(event);
      this.deps.emit({ type: "agent_event", event: { projectId, threadId, ...publicEvent } });
      const runId = this.turnContext.maybeCurrent()?.runId;
      const traces = this.deps.traces;
      const ctx = traces?.get(runId);
      if (runId && isToolExecutionEvent(event)) {
        let persistenceObservation: { turnIndex?: number; promptTokensBefore?: number } | undefined;
        if (event.type === "tool_execution_start") {
          toolStartedAt.set(event.toolCallId, performance.now());
        }
        if (event.type === "tool_execution_start" && ctx) {
          const observed = turnObservation.startTool(event.toolCallId);
          persistenceObservation = observed;
          const span = traces!.startSpan(runId, {
            name: `tool.${event.toolName}`,
            run_type: "tool",
            inputs: {
              arguments: capJson(event.args),
              argument_summary: summarizePayload(event.args),
            },
            metadata: {
              tool_call_id: event.toolCallId,
              tool_name: event.toolName,
              turn_index: observed?.turnIndex,
            },
          }, observed?.modelSpan);
          turnObservation.attachToolSpan(event.toolCallId, span);
          if (span) ctx.toolSpans.set(event.toolCallId, span);
        } else if (event.type === "tool_execution_start") {
          turnObservation.startTool(event.toolCallId);
        }
        if (event.type === "tool_execution_end") {
          const observed = turnObservation.finishTool(event.toolCallId);
          persistenceObservation = observed;
          const failed = event.isError || (event.result && typeof event.result === "object"
            && (event.result as { details?: { ok?: boolean } }).details?.ok === false);
          if (!failed) toolState.recordUse(event.toolName);
          const startedAt = toolStartedAt.get(event.toolCallId) ?? performance.now();
          this.deps.metrics?.observeTool({
            tool: event.toolName,
            status: failed ? "failed" : "succeeded",
            durationSeconds: Math.max(0, performance.now() - startedAt) / 1_000,
          });
          toolStartedAt.delete(event.toolCallId);
          const span = ctx?.toolSpans.get(event.toolCallId);
          const observation = {
            turn_index: observed?.turnIndex,
            argument_result_accounting: "provider_turn_transition",
            result_summary: summarizePayload(redactToolResult(event.result)),
            prompt_tokens_before: observed?.promptTokensBefore,
            model_usage_before: observed?.before,
          };
          if (span && ctx) {
            if (failed) {
              traces!.annotate(span, { observation });
              traces!.recordError(span, mapErrorFromUnknown(
                (event.result as { details?: { error?: string } })?.details?.error
                  ?? "tool failed",
                { aborted: false },
              ));
            } else {
              const resultBudget = resultBudgetOf(event.result);
              traces!.end(span, {
                status: "ok",
                outputs: {
                  result: capJson(redactToolResult(event.result)),
                  ...(resultBudget ? { result_budget: resultBudget } : {}),
                  observation,
                },
              });
            }
            ctx.toolSpans.delete(event.toolCallId);
          }
        }
        this.writes.track(
          projectId,
          persistToolEvent(this.deps.chats, runId, event, persistenceObservation),
          runId,
        );
      }
      // model.turn + usage/cache 采集（L1 日志 / L2 span+root）
      if (event && typeof event === "object") {
        const et = (event as { type?: string }).type;
        if (et === "turn_start") {
          const turnIndex = runId ? turnObservation.startTurn(runId) : undefined;
          if (runId && turnIndex !== undefined) {
            this.writes.track(
              projectId,
              this.deps.chats.startModelTurn(runId, turnIndex, observedModel),
              runId,
            );
          }
          const frame = runId ? this.preparedFrames.get(runId) : undefined;
          const fingerprint = fingerprintAgentContext(
            session,
            toolState.snapshot(),
            frame?.frameSha256,
            frame?.trajectoryEpoch,
          );
          if (runId) this.requestFingerprints.set(runId, fingerprint);
          if (ctx) {
            ctx.cacheFingerprint = fingerprint;
          }
          if (ctx && !ctx.modelSpan) {
            ctx.modelSpan = traces!.startSpan(runId, {
              name: `model.turn.${turnIndex ?? 0}`,
              run_type: "llm",
              metadata: {
                model: observedModel,
                turn_index: turnIndex,
                system_sha256: fingerprint.systemSha256,
                tools_sha256: fingerprint.toolsSha256,
                history_prefix_sha256: fingerprint.historyPrefixSha256,
                active_tool_count: fingerprint.activeToolCount,
                history_message_count: fingerprint.historyMessageCount,
                tool_epoch: fingerprint.toolEpoch,
                working_set_sha256: fingerprint.workingSetSha256,
                working_set_size: fingerprint.workingSetSize,
                frame_sha256: fingerprint.frameSha256,
                trajectory_epoch: fingerprint.trajectoryEpoch,
                desk_full_truncated: frame?.contextBudget?.desk_full.truncated,
                desk_full_original_frame_chars: frame?.contextBudget?.desk_full.original_frame_chars,
                desk_full_emitted_frame_chars: frame?.contextBudget?.desk_full.emitted_frame_chars,
                desk_full_omitted_objects: frame?.contextBudget?.desk_full.omitted_objects,
                desk_full_resource_status: frame?.contextBudget?.desk_full.resource_status,
              },
            });
            turnObservation.attachModelSpan(ctx.modelSpan);
          }
        }
        if (et === "message_end") {
          const sample = sampleFromMessageEndEvent(event);
          if (sample) {
            const completedTurn = turnObservation.completeModel(sample);
            for (const update of completedTurn.toolUpdates) {
              traces?.annotate(update.span, {
                token_context: {
                  accounting: "shared_tool_batch_transition",
                  turn_index: update.turnIndex,
                  shared_batch_size: update.batchSize,
                  prompt_tokens_before: update.promptTokensBefore,
                  prompt_tokens_after: update.promptTokensAfter,
                  prompt_token_delta: update.promptTokenDelta,
                  model_usage_before: update.before,
                  model_usage_after: update.after,
                },
              });
              if (runId) {
                this.writes.track(
                  projectId,
                  this.deps.chats.completeToolTokenContext(runId, update.toolCallId, {
                    promptTokensAfter: update.promptTokensAfter,
                    promptTokenDelta: update.promptTokenDelta,
                    sharedBatchSize: update.batchSize,
                  }),
                  runId,
                );
              }
            }
            if (runId) {
              this.writes.track(
                projectId,
                this.deps.chats.finishModelTurn(runId, completedTurn.turnIndex, observedModel, sample),
                runId,
              );
            }
            this.deps.metrics?.observeModelUsage(sample);
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
                model: observedModel,
                sample,
                aggregate: ctx?.usageTotals,
                cacheContext: runId ? this.requestFingerprints.get(runId) : undefined,
              }));
            }
          }
          if (sample && ctx?.modelSpan) {
            traces!.end(ctx.modelSpan, {
              status: "ok",
              outputs: {
                turn_index: turnObservation.currentTurnIndex(),
                usage: sample,
              },
            });
            ctx.modelSpan = undefined;
          }
        }
        if (et === "agent_end" && runId) {
          this.releaseRunContext(runId);
        }
        if (et === "compaction_end") {
          const compaction = event as {
            aborted?: boolean;
            reason?: string;
            result?: { tokensBefore?: number; estimatedTokensAfter?: number };
          };
          if (!compaction.aborted && compaction.result) {
            this.markContextCompacted(session);
            const report = toolBatchLedgerReport.current;
            toolBatchLedgerReport.current = undefined;
            if (report && ctx) {
              const span = traces!.startSpan(runId, {
                name: "context.compaction",
                run_type: "chain",
                inputs: {
                  reason: compaction.reason,
                  tokens_before: compaction.result.tokensBefore,
                },
                metadata: {
                  ledger_schema_version: report.schema_version,
                  closed_batch_count: report.closed_batch_count,
                  open_tool_call_count: report.open_tool_call_count,
                },
              });
              traces!.end(span, {
                status: "ok",
                outputs: {
                  tool_batch_ledger: report,
                  pi_estimated_tokens_after_before_ledger: compaction.result.estimatedTokensAfter,
                },
              });
            }
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
