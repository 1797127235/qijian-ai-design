/** Agent 工具共享上下文：依赖、项目校验、桌面变更通知、本轮选中、异步 job。 */
import type { ArtifactService } from "../../services/artifact-service.js";
import type { CanvasGenerateService } from "../../services/canvas-generate-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import type { ImageGenerator } from "../../services/image-generator.js";
import type { AgentJobRunner } from "../async-job/runner.js";
import type { AgentJobStore } from "../async-job/store.js";
import type { EventSink } from "../events.js";

export interface ToolDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  /** 面板/Agent 共用生图管线 */
  generate: CanvasGenerateService;
  emit: EventSink;
  jobs?: AgentJobRunner;
  jobStore?: AgentJobStore;
}

export interface ToolSessionRef {
  threadId: string;
  /** 当前 run（每轮 prompt 变化，用 getter） */
  runId: () => string | undefined;
}

export interface ToolContext {
  projectId: string;
  deps: ToolDependencies;
  /** 本轮 prompt 的选中（方案 1，不缓存跨轮） */
  selectedArtifactIds: () => string[];
  /** 当前对话线程 / run（async job 记账） */
  session?: ToolSessionRef;
  changed: (artifactId?: string, undoable?: boolean) => void;
  ownedCurrent: (artifactId: string) => ReturnType<ArtifactService["currentArtifact"]>;
  place: (artifactId: string, kind: string, x: number, y: number, rot?: number, width?: number) => Promise<void>;
}

export function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function fail(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ok: false, ...details } };
}

export function storedFileInputRefs(fileIds: string[] | undefined) {
  return [...new Set(fileIds ?? [])].map((fileId) => ({ file_id: fileId }));
}

export function createToolContext(
  projectId: string,
  deps: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
  session?: ToolSessionRef,
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
  return { projectId, deps, selectedArtifactIds, session, changed, ownedCurrent, place };
}
