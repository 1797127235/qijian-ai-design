import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { CanvasGenerateService, PreparedGenerate } from "../services/canvas-generate-service.js";
import type { DatabaseTransaction } from "../services/artifact-service.js";
import { composeCanvasPrompt, stripInpaintPrefix } from "../services/canvas-generate-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ProjectMemoryService } from "../agent/memory/service.js";
import type { ImageGenerateTaskV1 } from "./types.js";
import { TaskStore } from "./task-store.js";
import { composePromptWithProjectMemory } from "./panel-image-task.js";

export type AssetTaskPlacement =
  | { mode: "beside"; sourceArtifactId: string; referenceArtifactIds: string[] }
  | { mode: "replace"; sourceArtifactId: string; referenceArtifactIds: string[] }
  | { mode: "spawn"; referenceArtifactIds: string[]; x?: number; y?: number };

export class AssetTaskSubmissionService {
  constructor(
    private readonly store: TaskStore,
    private readonly generate: CanvasGenerateService,
    private readonly desks: DeskStateService,
    private readonly config: Pick<ServerConfig, "imageModel">,
    private readonly memory?: ProjectMemoryService,
  ) {}

  async submitAgentImage(input: {
    projectId: string;
    threadId: string;
    runId?: string;
    prompt: string;
    model?: string;
    toolName: string;
    toolCallId: string;
    placement: AssetTaskPlacement;
  }) {
    const snapshot = await this.desks.snapshot(input.projectId);
    const taskId = randomUUID();
    const userPrompt = stripInpaintPrefix(input.prompt) || "生成效果图";
    const memory = await this.memory?.freezeForGeneration(input.projectId);
    const prompt = composePromptWithProjectMemory(
      composeCanvasPrompt({ userPrompt, missingRef: false }),
      memory,
    );
    const sourceId = input.placement.mode === "spawn" ? undefined : input.placement.sourceArtifactId;
    const source = sourceId ? snapshot.artifacts.find((artifact) => artifact.id === sourceId) : undefined;
    if (sourceId && !source) throw new HttpError(404, "源物件不在桌面上");
    const sourceFileId = source?.payload.file_id;
    if (source && (typeof sourceFileId !== "string" || !sourceFileId)) {
      throw new HttpError(422, "BullMQ 生图要求源物件包含已冻结的图片版本");
    }
    const explicitReferenceIds = input.placement.referenceArtifactIds;
    const inboundIds = sourceId
      ? snapshot.deskState.connections.filter((edge) => edge.to === sourceId).map((edge) => edge.from)
      : [];
    const referenceIds = [...new Set([...inboundIds, ...explicitReferenceIds])]
      .filter((id) => id !== sourceId);
    const references = referenceIds.map((id) => {
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === id);
      const fileId = artifact?.payload.file_id;
      if (!artifact || typeof fileId !== "string" || !fileId) {
        throw new HttpError(422, `参考物件 ${id} 没有可冻结的图片版本`);
      }
      return { artifact_id: artifact.id, version_id: artifact.versionId, file_id: fileId };
    });
    const target = input.placement.mode === "replace" ? source : undefined;
    const payload: ImageGenerateTaskV1 = {
      schema_version: 1,
      kind: "image.generate",
      operation: input.placement.mode,
      project_id: input.projectId,
      task_id: taskId,
      source: source && typeof sourceFileId === "string"
        ? { artifact_id: source.id, version_id: source.versionId, file_id: sourceFileId }
        : undefined,
      references,
      target_artifact_id: target?.id,
      target_version: target ? target.versionNo + 1 : 1,
      prompt,
      user_prompt: userPrompt,
      model: input.model ?? this.config.imageModel ?? "grok-imagine-image-quality",
      origin: { type: "agent", name: input.toolName },
      generation_memory: memory,
    };

    let prepared: PreparedGenerate | undefined;
    await this.store.accept({
      payload,
      taskKind: "generate_from_desk",
      threadId: input.threadId,
      runId: input.runId,
      prepare: async (tx: DatabaseTransaction) => {
        const clientOpId = `agent:${input.toolCallId || taskId}`;
        prepared = await this.generate.prepare({
          projectId: input.projectId,
          sourceArtifactId: sourceId,
          prompt: userPrompt,
          clientOpId,
          targetArtifactId: target?.id,
          referenceArtifactIds: explicitReferenceIds,
          spawnAt: input.placement.mode === "spawn"
            && Number.isFinite(input.placement.x)
            && Number.isFinite(input.placement.y)
            ? { x: input.placement.x as number, y: input.placement.y as number }
            : undefined,
          source: "agent_chat",
          createdBy: "agent",
          model: input.model,
        }, tx);
        return { artifactId: prepared.pending.artifact.id };
      },
    });
    // prepare 在 accept 事务内，*InTransaction 不 emit；通知前端出现 pending 卡
    this.desks.notifyDeskChanged(input.projectId);
    return { taskId, payload, pending: prepared!.pending };
  }
}
