/**
 * 工具共享层：每个工具的依赖 + 上下文工厂。
 *  - 工具的 ok / fail 协议：{content: [{type:"text", text}], details}
 *  - place/ownedCurrent 工具内复用的高层动作
 *  - 工具不直接 import service，都走 ToolDependencies
 *  - agentSession 供 search_tools additive activation
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { CanvasGenerateService } from "../../services/canvas-generate-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import type { FileStorage } from "../../services/file-storage.js";
import type { ImageGenerator } from "../../services/image-generator.js";
import type { AgentJobStore } from "../async-job/store.js";
import type { AssetTaskSubmissionService } from "../../tasks/asset-task-submission.js";
import type { TaskCancellationService } from "../../tasks/cancellation.js";
import type { ProjectMemoryService } from "../memory/service.js";
import type { EventSink } from "../events.js";
import { mapError, type ErrorCode } from "../tracing/index.js";
import type { TurnContextScope } from "../capability-gate.js";
import type { SessionToolState } from "./session-tool-state.js";
import type { SessionSkillState } from "../skills/session-skill-state.js";
import type { ContextResourceStore } from "../context/resource-store.js";

export interface ToolDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  /** 面板/Agent 共用生图管线 */
  generate: CanvasGenerateService;
  /** 读盘（look_at_desk 总览缩略） */
  files: FileStorage;
  emit: EventSink;
  jobStore?: AgentJobStore;
  taskCancellation?: TaskCancellationService;
  /** 生图 model allowlist（与面板一致）；generate_from_desk 校验/归一化用 */
  imageModelOptions?: string[];
  assetTaskSubmitter?: AssetTaskSubmissionService;
  memory?: ProjectMemoryService;
}

export interface ToolSessionRef {
  threadId: string;
  runId: () => string | undefined;
}

export interface ToolRuntime {
  threadId: string;
  turnContext: TurnContextScope;
  agentSession: () => AgentSession | undefined;
  toolState: () => SessionToolState | undefined;
  skillState: () => SessionSkillState | undefined;
  resourceStore: ContextResourceStore;
}

export interface ToolContext {
  projectId: string;
  deps: ToolDependencies;
  /** 本轮 prompt 的选中（方案 1，不缓存跨轮） */
  selectedArtifactIds: () => string[];
  /** 当前对话线程 / run（async job 记账） */
  session?: ToolSessionRef;
  /** pi session（create 后注入；search_tools 激活工具用） */
  agentSession?: () => AgentSession | undefined;
  toolState?: () => SessionToolState | undefined;
  skillState?: () => SessionSkillState | undefined;
  resourceStore: ContextResourceStore;
  changed: (artifactId?: string, undoable?: boolean) => void;
  ownedCurrent: (artifactId: string) => ReturnType<ArtifactService["currentArtifact"]>;
  place: (artifactId: string, kind: string, x: number, y: number, rot?: number, width?: number) => Promise<void>;
}

/** 工具成功结果：text 给 LLM 读，details 持久化到 chat_tool_calls。显式 ok:true 供失败判定采信（正文散文里的"失败/无法"等词不构成失败）。 */
export function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ...details, ok: true } };
}

/** 工具失败结果：details 自动带 ok:false + error_code（H7）。 */
export function fail(text: string, details: Record<string, unknown> = {}) {
  const existingCode = typeof details.error_code === "string" ? details.error_code as ErrorCode : undefined;
  const mapped = mapError({
    message: typeof details.error === "string" ? String(details.error) : text,
    code: existingCode,
  });
  const error_code = existingCode ?? mapped.error_code;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      ...details,
      ok: false,
      error: typeof details.error === "string" ? details.error : mapped.message,
      error_code,
    },
  };
}

/** file_id 列表 → artifact_versions.inputRefs 结构（去重 + 包装）。 */
export function storedFileInputRefs(fileIds: string[] | undefined) {
  return [...new Set(fileIds ?? [])].map((fileId) => ({ file_id: fileId }));
}

/**
 * 工具上下文工厂：
 *  - changed: 写桌后 emit object_changed（前端可监听此事件触发 refetch）
 *  - ownedCurrent: 校验 artifact 归属当前项目，并返回当前版本
 *  - place: 工具内的「放一个物件到桌面」快捷动作
 */
export function createToolContext(
  projectId: string,
  deps: ToolDependencies,
  runtime: ToolRuntime,
): ToolContext {
  const changed = (artifactId?: string, undoable = false) => {
    deps.emit({ type: "object_changed", projectId, artifactId, undoable });
  };
  const ownedCurrent = async (artifactId: string) => {
    const current = await deps.artifacts.currentArtifact(artifactId);
    if (current.artifact.projectId !== projectId) throw new Error("Artifact 不属于当前项目");
    return current;
  };
  const place = async (artifactId: string, kind: string, x: number, y: number, rot = 0, width?: number) => {
    await deps.desks.placeObject(projectId, {
      artifact_id: artifactId,
      kind,
      x,
      y,
      rot,
      ...(width === undefined ? {} : { w: width }),
    });
    changed(artifactId);
  };
  return {
    projectId,
    deps,
    selectedArtifactIds: () => [...runtime.turnContext.current().selectedArtifactIds],
    session: {
      threadId: runtime.threadId,
      runId: () => runtime.turnContext.maybeCurrent()?.runId,
    },
    agentSession: runtime.agentSession,
    toolState: runtime.toolState,
    skillState: runtime.skillState,
    resourceStore: runtime.resourceStore,
    changed,
    ownedCurrent,
    place,
  };
}
