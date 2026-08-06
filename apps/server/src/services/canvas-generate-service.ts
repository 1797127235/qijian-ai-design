import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { storedFiles } from "../db/schema.js";
import type { ArtifactType, DeskConnection, DeskLayoutObject } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { ArtifactService } from "./artifact-service.js";
import type { DeskStateService } from "./desk-state-service.js";
import type { FileStorage } from "./file-storage.js";
import type { ImageGenerator, ReferenceFile } from "./image-generator.js";

const EFFECT_WIDTH = 220;
const PLACE_GAP = 60;
const GENERATE_TIMEOUT_MS = 120_000;

export type GenerateSource = "canvas_panel" | "agent_chat";
export type GenerateCreatedBy = "designer" | "agent";

export interface GenerateFromCanvasInput {
  projectId: string;
  sourceArtifactId: string;
  prompt: string;
  clientOpId: string;
  /**
   * 重试时传入已有失败/待生成的 effect_image id，在原卡上 append，不新建。
   * 省略则 createPlaced 新卡。
   */
  targetArtifactId?: string;
  /** 默认 canvas_panel；Agent 工具传 agent_chat */
  source?: GenerateSource;
  createdBy?: GenerateCreatedBy;
  /** 外部取消（agent stop / 工具 AbortSignal） */
  signal?: AbortSignal;
}

export interface GenerateFromCanvasResult {
  artifact: { id: string };
  version: { id: string; status: string };
  object: DeskLayoutObject;
  connection: DeskConnection;
  status: "pending" | "succeeded" | "failed";
  error?: string;
}

export class CanvasGenerateService {
  private readonly recent = new Map<string, { result: GenerateFromCanvasResult; expiresAt: number }>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactService,
    private readonly desks: DeskStateService,
    private readonly files: FileStorage,
    private readonly images: ImageGenerator,
  ) {}

  async generate(input: GenerateFromCanvasInput): Promise<GenerateFromCanvasResult> {
    const hit = this.recent.get(input.clientOpId);
    if (hit && hit.expiresAt > Date.now()) return hit.result;

    const origin = input.source ?? "canvas_panel";
    const createdBy = input.createdBy ?? "designer";

    const snapshot = await this.desks.snapshot(input.projectId);
    const source = snapshot.artifacts.find((a) => a.id === input.sourceArtifactId);
    const sourceLayout = snapshot.deskState.objects.find((o) => o.artifact_id === input.sourceArtifactId);
    if (!source || !sourceLayout) throw new HttpError(404, "源物件不在桌面上");

    // 参考图/便签来自「源物件」的入边，重试时仍按真实源解析，不按失败卡
    const inbound = snapshot.deskState.connections.filter((c) => c.to === input.sourceArtifactId);
    const { referenceFileIds, noteTexts } = this.collectReferences(snapshot, source, inbound);
    const composedPrompt = this.composePrompt(
      input.prompt,
      noteTexts,
      referenceFileIds.length < this.expectedImageRefs(snapshot, source, inbound),
    );

    const prepared = input.targetArtifactId
      ? await this.prepareRetryTarget(input, snapshot, composedPrompt, referenceFileIds, origin, createdBy)
      : await this.prepareNewTarget(input, sourceLayout, composedPrompt, referenceFileIds, origin, createdBy);

    const pending: GenerateFromCanvasResult = {
      artifact: { id: prepared.artifactId },
      version: { id: prepared.versionId, status: prepared.versionStatus },
      object: prepared.object,
      connection: prepared.connection,
      status: "pending",
    };
    this.recent.set(input.clientOpId, { result: pending, expiresAt: Date.now() + 10 * 60 * 1000 });

    // 互斥键：重试锁目标卡，新建锁源（避免同源连点出多张）
    const key = `${input.projectId}:${input.targetArtifactId ?? input.sourceArtifactId}`;
    this.inflight.get(key)?.abort();
    const controller = new AbortController();
    this.inflight.set(key, controller);
    const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    // 外部 stop → 一并取消图像 HTTP
    const onExternalAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const referenceFiles = await this.loadReferenceFiles(input.projectId, referenceFileIds);
      const generated = await this.images.generate(
        {
          projectId: input.projectId,
          context: composedPrompt,
          intent: "canvas_panel",
          referenceFiles,
        },
        controller.signal,
      );
      const version = await this.artifacts.append(prepared.artifactId, {
        payload: {
          file_id: generated.fileId,
          prompt: composedPrompt,
          source: origin,
          pending: false,
          source_url: generated.sourceUrl,
        },
        inputRefs: referenceFileIds.map((file_id) => ({ file_id })),
        status: "confirmed",
        createdBy,
      });
      const done: GenerateFromCanvasResult = {
        ...pending,
        version: { id: version.id, status: version.status },
        status: "succeeded",
      };
      this.recent.set(input.clientOpId, { result: done, expiresAt: Date.now() + 10 * 60 * 1000 });
      return done;
    } catch (error) {
      const message = error instanceof Error
        ? (error.name === "AbortError" ? "生成已取消或超时" : error.message)
        : "生成失败";
      try {
        await this.artifacts.append(prepared.artifactId, {
          payload: { pending: false, prompt: composedPrompt, source: origin, error: message },
          inputRefs: referenceFileIds.map((file_id) => ({ file_id })),
          status: "draft",
          createdBy,
        });
      } catch {
        // best-effort
      }
      const failed: GenerateFromCanvasResult = { ...pending, status: "failed", error: message };
      this.recent.set(input.clientOpId, { result: failed, expiresAt: Date.now() + 10 * 60 * 1000 });
      return failed;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternalAbort);
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
    }
  }

  abort(projectId: string, sourceArtifactId: string) {
    const key = `${projectId}:${sourceArtifactId}`;
    this.inflight.get(key)?.abort();
    this.inflight.delete(key);
  }

  /** 取消该项目所有进行中的生图（agent stop） */
  abortProject(projectId: string) {
    const prefix = `${projectId}:`;
    for (const [key, controller] of this.inflight) {
      if (!key.startsWith(prefix)) continue;
      controller.abort();
      this.inflight.delete(key);
    }
  }

  /** 新建 effect 卡 + 源→新图连线 */
  private async prepareNewTarget(
    input: GenerateFromCanvasInput,
    sourceLayout: DeskLayoutObject,
    composedPrompt: string,
    referenceFileIds: string[],
    origin: GenerateSource,
    createdBy: GenerateCreatedBy,
  ) {
    const layout: Omit<DeskLayoutObject, "artifact_id"> = {
      kind: "effect_image",
      x: Math.round(sourceLayout.x + (sourceLayout.w ?? EFFECT_WIDTH) + PLACE_GAP),
      y: Math.round(sourceLayout.y),
      rot: 0,
      w: EFFECT_WIDTH,
    };
    const placed = await this.artifacts.createPlaced(
      input.projectId,
      "effect_image",
      {
        payload: { pending: true, prompt: composedPrompt, source: origin },
        inputRefs: referenceFileIds.map((file_id) => ({ file_id })),
        status: "draft",
        createdBy,
      },
      layout,
      input.clientOpId,
    );
    const connection = await this.desks.createConnection(
      input.projectId,
      input.sourceArtifactId,
      placed.artifact.id,
      `${input.clientOpId}:conn`,
    );
    return {
      artifactId: placed.artifact.id,
      versionId: placed.version.id,
      versionStatus: placed.version.status,
      object: placed.object,
      connection,
    };
  }

  /** 在已有失败/草稿 effect 卡上重置为 pending，不新建物件 */
  private async prepareRetryTarget(
    input: GenerateFromCanvasInput,
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    composedPrompt: string,
    referenceFileIds: string[],
    origin: GenerateSource,
    createdBy: GenerateCreatedBy,
  ) {
    const targetId = input.targetArtifactId!;
    const target = snapshot.artifacts.find((a) => a.id === targetId);
    const targetLayout = snapshot.deskState.objects.find((o) => o.artifact_id === targetId);
    if (!target || !targetLayout) throw new HttpError(404, "重试目标不在桌面上");
    if (target.artifactType !== "effect_image") throw new HttpError(422, "只能在效果图上重试生成");

    // 优先用已有「源→目标」连线；没有则用请求里的 sourceArtifactId 补一条
    let connection = snapshot.deskState.connections.find((c) => c.to === targetId && c.from === input.sourceArtifactId)
      ?? snapshot.deskState.connections.find((c) => c.to === targetId);
    if (!connection) {
      connection = await this.desks.createConnection(
        input.projectId,
        input.sourceArtifactId,
        targetId,
        `${input.clientOpId}:conn`,
      );
    }

    const version = await this.artifacts.append(targetId, {
      payload: { pending: true, prompt: composedPrompt, source: origin },
      inputRefs: referenceFileIds.map((file_id) => ({ file_id })),
      status: "draft",
      createdBy,
    });

    return {
      artifactId: targetId,
      versionId: version.id,
      versionStatus: version.status,
      object: targetLayout,
      connection,
    };
  }

  private expectedImageRefs(
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    source: { id: string; artifactType: ArtifactType; payload: Record<string, unknown> },
    inbound: DeskConnection[],
  ) {
    let n = 0;
    if ((source.artifactType === "canvas_image" || source.artifactType === "effect_image") && typeof source.payload.file_id === "string") n += 1;
    for (const edge of inbound) {
      const art = snapshot.artifacts.find((a) => a.id === edge.from);
      if (art && (art.artifactType === "canvas_image" || art.artifactType === "effect_image") && typeof art.payload.file_id === "string") n += 1;
    }
    return n;
  }

  private collectReferences(
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    source: { id: string; artifactType: ArtifactType; payload: Record<string, unknown> },
    inbound: DeskConnection[],
  ) {
    const referenceFileIds: string[] = [];
    const noteTexts: string[] = [];
    const pushFile = (payload: Record<string, unknown>) => {
      const id = payload.file_id;
      if (typeof id === "string" && id && !referenceFileIds.includes(id)) referenceFileIds.push(id);
    };
    if (source.artifactType === "canvas_image" || source.artifactType === "effect_image") pushFile(source.payload);
    if (source.artifactType === "sticky_note" && typeof source.payload.text === "string" && source.payload.text.trim()) {
      noteTexts.push(source.payload.text.trim());
    }
    for (const edge of inbound) {
      const art = snapshot.artifacts.find((a) => a.id === edge.from);
      if (!art) continue;
      if (art.artifactType === "canvas_image" || art.artifactType === "effect_image") pushFile(art.payload);
      if (art.artifactType === "sticky_note" && typeof art.payload.text === "string" && art.payload.text.trim()) {
        noteTexts.push(art.payload.text.trim());
      }
    }
    return { referenceFileIds, noteTexts };
  }

  private composePrompt(userPrompt: string, noteTexts: string[], missingRef: boolean) {
    const parts = [userPrompt.trim()].filter(Boolean);
    if (noteTexts.length > 0) parts.push(`参考要求：${noteTexts.join("；")}`);
    if (missingRef) parts.push("（有参考图缺失）");
    return parts.join("\n") || "生成效果图";
  }

  private async loadReferenceFiles(projectId: string, fileIds: string[]): Promise<ReferenceFile[]> {
    const out: ReferenceFile[] = [];
    for (const fileId of fileIds) {
      try {
        const [row] = await this.db
          .select()
          .from(storedFiles)
          .where(and(eq(storedFiles.id, fileId), eq(storedFiles.projectId, projectId)));
        if (!row) continue;
        const bytes = new Uint8Array(await this.files.read(row.objectKey));
        out.push({ mediaType: row.mediaType, bytes, filename: row.originalFilename });
      } catch {
        // skip missing
      }
    }
    return out;
  }
}
