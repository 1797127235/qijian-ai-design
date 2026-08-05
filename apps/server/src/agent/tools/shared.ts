/** Agent 工具共享上下文：集中提供依赖、项目归属校验和桌面变更通知。 */
import type { ArtifactService } from "../../services/artifact-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import type { ExportService } from "../../services/export-service.js";
import type { ImageGenerator } from "../../services/image-generator.js";
import type { EventSink } from "../events.js";

export interface ToolDependencies {
  artifacts: ArtifactService;
  desks: DeskStateService;
  effects: ImageGenerator;
  exports: ExportService;
  emit: EventSink;
}

export interface ToolContext {
  projectId: string;
  deps: ToolDependencies;
  changed: (artifactId?: string, undoable?: boolean) => void;
  ownedCurrent: (artifactId: string) => ReturnType<ArtifactService["currentArtifact"]>;
  place: (artifactId: string, kind: string, x: number, y: number, rot?: number, width?: number) => Promise<void>;
}

export function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createToolContext(projectId: string, deps: ToolDependencies): ToolContext {
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
  return { projectId, deps, changed, ownedCurrent, place };
}
