import { and, eq } from "drizzle-orm";
import { storedFiles } from "../db/schema.js";
import type { ArtifactService } from "../services/artifact-service.js";
import { buildInpaintReferences } from "../services/canvas-generate-service.js";
import type { FileStorage } from "../services/file-storage.js";
import type { ImageGenerator, ReferenceFile } from "../services/image-generator.js";
import type { GenerationOperation, GenerationOperationTransaction } from "./generation-operation-store.js";
import type { GeneratedTaskAsset } from "./handlers/image-generate.js";
import type { ImageGenerateTaskV1 } from "./types.js";

type PersistedGeneratedImage = {
  fileId: string;
  sourceUrl: string;
};

export class ImageTaskExecutor {
  constructor(
    private readonly files: FileStorage,
    private readonly images: ImageGenerator,
    private readonly artifacts: ArtifactService,
  ) {}

  async generate(task: ImageGenerateTaskV1): Promise<GeneratedTaskAsset> {
    const refs = [task.source, ...task.references].filter(
      (ref): ref is NonNullable<typeof ref> => Boolean(ref),
    );
    const loaded = await this.loadReferences(task.project_id, refs.map((ref) => ref.file_id));
    let uploaded: ReferenceFile | undefined;
    if (task.reference_file_id) {
      [uploaded] = await this.loadReferences(task.project_id, [task.reference_file_id]);
      if (!uploaded) throw new Error("frozen reference file is missing");
    }
    const referenceFiles = await buildInpaintReferences({
      referenceFiles: loaded,
      region: task.region,
      referenceFile: uploaded,
    });
    const generated = await this.images.generate({
      projectId: task.project_id,
      context: task.prompt,
      intent: task.origin.name,
      referenceFiles,
      size: task.size,
      model: task.model,
    });
    return {
      result: { fileId: generated.fileId, sourceUrl: generated.sourceUrl },
      resultFileId: generated.fileId,
      providerRequestId: generated.providerId,
    };
  }

  async finalize(
    tx: GenerationOperationTransaction,
    task: ImageGenerateTaskV1,
    operation: GenerationOperation,
  ) {
    const targetArtifactId = operation.targetArtifactId;
    if (!targetArtifactId) throw new Error("generation operation has no target artifact");
    const generated = operation.result as Partial<PersistedGeneratedImage> | null;
    if (!generated?.fileId || !generated.sourceUrl) {
      throw new Error("generation operation has no downloaded image result");
    }
    const inputRefs = [task.source, ...task.references]
      .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
      .map((ref) => ({ file_id: ref.file_id }));
    if (task.reference_file_id) inputRefs.push({ file_id: task.reference_file_id });
    const payload = {
      file_id: generated.fileId,
      pending: false,
      source_url: generated.sourceUrl,
      ...this.generationFields(task),
    };
    const { version } = await this.artifacts.appendInTransaction(tx, targetArtifactId, {
      payload,
      inputRefs,
      status: "confirmed",
      createdBy: task.origin.type === "agent" ? "agent" : "designer",
    }, { expectedCurrentVersion: operation.expectedTargetVersion });
    return { artifactId: targetArtifactId, versionId: version.id, status: "succeeded" as const };
  }

  /**
   * 失败/取消/needs_review 时把 pending 卡收成可展示终态，避免 UI 永久「生成中」。
   * best-effort：artifact 已删或并发 CAS 失败不抛回 worker。
   */
  async failPending(artifactId: string, task: ImageGenerateTaskV1, error: string): Promise<void> {
    try {
      await this.artifacts.append(artifactId, {
        payload: {
          pending: false,
          error: error.slice(0, 2_000),
          ...this.generationFields(task),
        },
        status: "draft",
        createdBy: task.origin.type === "agent" ? "agent" : "designer",
      });
    } catch {
      // intentional best-effort
    }
  }

  private generationFields(task: ImageGenerateTaskV1) {
    return {
      prompt: task.prompt,
      user_prompt: task.user_prompt ?? task.prompt,
      source: task.origin.type === "agent" ? "agent_chat" : "canvas_panel",
      ...(task.region ? { region: task.region, inpaint: true as const } : {}),
      ...(task.reference_file_id ? { reference_file_id: task.reference_file_id } : {}),
      ...(task.size ? { size: task.size } : {}),
      model: task.model,
      ...(task.generation_memory ? { generation_memory: task.generation_memory } : {}),
    };
  }

  private async loadReferences(projectId: string, fileIds: string[]): Promise<ReferenceFile[]> {
    const out: ReferenceFile[] = [];
    for (const fileId of [...new Set(fileIds)]) {
      const stored = await this.files.getById(fileId);
      if (!stored || stored.projectId !== projectId) continue;
      const bytes = new Uint8Array(await this.files.read(stored.objectKey));
      out.push({ mediaType: stored.mediaType, bytes, filename: stored.originalFilename });
    }
    return out;
  }
}
