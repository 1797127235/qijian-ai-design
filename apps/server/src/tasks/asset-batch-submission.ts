import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../config.js";
import type { DeskSnapshot } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { CanvasGenerateService, PreparedGenerate } from "../services/canvas-generate-service.js";
import type { DatabaseTransaction } from "../services/artifact-service.js";
import { composeCanvasPrompt, stripInpaintPrefix } from "../services/canvas-generate-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ProjectMemoryService } from "../agent/memory/service.js";
import type { GenerationMemorySnapshot } from "./types.js";
import { composePromptWithProjectMemory } from "./panel-image-task.js";
import { TaskStore } from "./task-store.js";
import type { ImageGenerateTaskV1 } from "./types.js";

export type BatchImageRequest = {
  prompt: string;
  sourceArtifactId?: string;
  targetArtifactId?: string;
  referenceArtifactIds?: string[];
  spawnAt?: { x: number; y: number };
  region?: { x: number; y: number; w: number; h: number };
  referenceFileId?: string;
  size?: string;
  model?: string;
  clientOpId?: string;
};

export class AssetBatchSubmissionService {
  constructor(
    private readonly store: TaskStore,
    private readonly generate: CanvasGenerateService,
    private readonly desks: DeskStateService,
    private readonly config: Pick<ServerConfig, "imageModel">,
    private readonly memory?: ProjectMemoryService,
  ) {}

  async submit(input: {
    projectId: string;
    createdBy: "designer" | "agent";
    requests: BatchImageRequest[];
  }) {
    if (input.requests.length < 1 || input.requests.length > 20) {
      throw new HttpError(422, "批次任务数必须在 1-20 之间");
    }
    const snapshot = await this.desks.snapshot(input.projectId);
    const preparedByTask = new Map<string, PreparedGenerate>();
    const taskInputs = await Promise.all(input.requests.map(async (request) => {
      const taskId = randomUUID();
      const generationMemory = await this.memory?.freezeForGeneration(input.projectId);
      const payload = this.freezePayload(snapshot, input.projectId, taskId, request, generationMemory);
      return {
        payload,
        taskKind: "batch_generate",
        prepare: async (tx: DatabaseTransaction) => {
          const clientOpId = request.clientOpId?.trim() || `batch:${taskId}`;
          const prepared = await this.generate.prepare({
            projectId: input.projectId,
            sourceArtifactId: request.sourceArtifactId,
            targetArtifactId: request.targetArtifactId,
            referenceArtifactIds: request.referenceArtifactIds,
            prompt: request.prompt,
            clientOpId,
            spawnAt: request.spawnAt,
            region: request.region,
            referenceFileId: request.referenceFileId,
            size: request.size,
            model: request.model,
            source: "canvas_panel",
            createdBy: input.createdBy,
          }, tx);
          preparedByTask.set(taskId, prepared);
          return { artifactId: prepared.pending.artifact.id };
        },
      };
    }));
    const accepted = await this.store.acceptBatch({
      projectId: input.projectId,
      createdBy: input.createdBy,
      input: input.requests,
      tasks: taskInputs,
    });
    this.desks.notifyDeskChanged(input.projectId);
    return {
      batch: accepted.batch,
      tasks: accepted.tasks.map((task) => ({
        task,
        pending: preparedByTask.get(task.id)?.pending,
      })),
    };
  }

  private freezePayload(
    snapshot: DeskSnapshot,
    projectId: string,
    taskId: string,
    request: BatchImageRequest,
    generationMemory?: GenerationMemorySnapshot,
  ): ImageGenerateTaskV1 {
    const source = request.sourceArtifactId
      ? snapshot.artifacts.find((artifact) => artifact.id === request.sourceArtifactId)
      : undefined;
    if (request.sourceArtifactId && !source) throw new HttpError(404, "批次源物件不存在");
    const sourceFileId = source?.payload.file_id;
    if (source && typeof sourceFileId !== "string" || (request.sourceArtifactId && !sourceFileId)) {
      throw new HttpError(422, "批次源物件没有可冻结的图片版本");
    }
    const referenceIds = [...new Set(request.referenceArtifactIds ?? [])].filter((id) => id !== source?.id);
    const references = referenceIds.map((id) => {
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === id);
      const fileId = artifact?.payload.file_id;
      if (!artifact || typeof fileId !== "string" || !fileId) throw new HttpError(422, "批次参考物件没有图片版本");
      return { artifact_id: artifact.id, version_id: artifact.versionId, file_id: fileId };
    });
    const userPrompt = stripInpaintPrefix(request.prompt) || "生成效果图";
    return {
      schema_version: 1,
      kind: "image.generate",
      operation: request.region ? "inpaint" : request.targetArtifactId ? "replace" : request.sourceArtifactId ? "beside" : "spawn",
      project_id: projectId,
      task_id: taskId,
      source: source && typeof sourceFileId === "string"
        ? { artifact_id: source.id, version_id: source.versionId, file_id: sourceFileId }
        : undefined,
      references,
      target_artifact_id: request.targetArtifactId,
      target_version: request.targetArtifactId
        ? (snapshot.artifacts.find((artifact) => artifact.id === request.targetArtifactId)?.versionNo ?? 0) + 1
        : 1,
      prompt: composePromptWithProjectMemory(
        composeCanvasPrompt({ userPrompt, missingRef: false, region: request.region }),
        generationMemory,
      ),
      user_prompt: userPrompt,
      model: request.model ?? this.config.imageModel ?? "grok-imagine-image-quality",
      size: request.size,
      region: request.region,
      reference_file_id: request.referenceFileId,
      origin: { type: "batch", name: "batch-generate" },
      generation_memory: generationMemory,
    };
  }
}
