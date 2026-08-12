import type { DeskSnapshot } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import { composeCanvasPrompt, stripInpaintPrefix } from "../services/canvas-generate-service.js";
import type { GenerationMemorySnapshot, ImageGenerateTaskV1 } from "./types.js";

export function composePromptWithProjectMemory(prompt: string, memory?: GenerationMemorySnapshot): string {
  if (!memory?.compiled_design_context.trim()) return prompt;
  return `${memory.compiled_design_context}\n\n[CURRENT_GENERATION_REQUEST]\n${prompt}`;
}

type PanelImageInput = {
  prompt: string;
  sourceArtifactId: string;
  targetArtifactId?: string;
  region?: { x: number; y: number; w: number; h: number };
  referenceFileId?: string;
  size?: string;
  model?: string;
};

export function createPanelImageTaskPayload(input: {
  snapshot: DeskSnapshot;
  taskId: string;
  request: PanelImageInput;
  defaultModel: string;
  generationMemory?: GenerationMemorySnapshot;
}): ImageGenerateTaskV1 {
  const source = input.snapshot.artifacts.find((artifact) => artifact.id === input.request.sourceArtifactId);
  const sourceFileId = source?.payload.file_id;
  if (!source || typeof sourceFileId !== "string" || !sourceFileId) {
    throw new HttpError(422, "BullMQ 生图要求源物件包含已冻结的图片版本");
  }
  const target = input.request.targetArtifactId
    ? input.snapshot.artifacts.find((artifact) => artifact.id === input.request.targetArtifactId)
    : undefined;
  if (input.request.targetArtifactId && !target) throw new HttpError(404, "重试目标不在桌面上");

  const references = input.snapshot.deskState.connections
    .filter((connection) => connection.to === source.id)
    .flatMap((connection) => {
      const artifact = input.snapshot.artifacts.find((candidate) => candidate.id === connection.from);
      const fileId = artifact?.payload.file_id;
      return artifact && typeof fileId === "string" && fileId
        ? [{ artifact_id: artifact.id, version_id: artifact.versionId, file_id: fileId }]
        : [];
    });
  const userPrompt = stripInpaintPrefix(input.request.prompt) || "生成效果图";
  const prompt = composeCanvasPrompt({
    userPrompt,
    missingRef: false,
    region: input.request.region,
    hasReferenceFile: Boolean(input.request.referenceFileId),
  });

  return {
    schema_version: 1,
    kind: "image.generate",
    operation: input.request.region ? "inpaint" : target ? "replace" : "beside",
    project_id: input.snapshot.project.id,
    task_id: input.taskId,
    source: { artifact_id: source.id, version_id: source.versionId, file_id: sourceFileId },
    references,
    target_artifact_id: target?.id,
    target_version: target ? target.versionNo + 1 : 1,
    prompt: composePromptWithProjectMemory(prompt, input.generationMemory),
    user_prompt: userPrompt,
    model: input.request.model ?? input.defaultModel,
    size: input.request.size,
    region: input.request.region,
    reference_file_id: input.request.referenceFileId,
    origin: { type: "panel", name: "generate-image" },
    generation_memory: input.generationMemory,
  };
}
