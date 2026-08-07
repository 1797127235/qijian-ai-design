import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { storedFiles } from "../db/schema.js";
import type { ArtifactType, DeskConnection, DeskLayoutObject } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { ArtifactService } from "./artifact-service.js";
import type { DeskStateService } from "./desk-state-service.js";
import type { FileStorage } from "./file-storage.js";
import type { ImageGenerator, ReferenceFile } from "./image-generator.js";

/**
 * 画布生成编排服务：把「源物件 + prompt」变成「源旁落一张 effect_image」的全套动作。
 *
 * 这是 Agent 与面板共用写桌的唯一入口。
 *
 * 两阶段：
 *  - prepare：快照 → 收集参考 → 落 pending 卡 + 连线（同步、可重入、可幂等）
 *  - complete：调图像 API → append 终态版本（可后台、可取消、可重试）
 *
 * 取消与超时：
 *  - per lockKey 维护 AbortController，重复请求会先 abort 上一个
 *  - 120s 兜底超时；外部 signal 可提前 abort（agent stop）
 *  - 失败 best-effort 写一版 payload.error，前端就能看到红色失败状态
 */
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
  /** 额外参考物件（不含主源）；与主源入边合并去重 */
  referenceArtifactIds?: string[];
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

/** prepare 阶段产物，供 Agent 异步 complete 使用。 */
export interface PreparedGenerate {
  pending: GenerateFromCanvasResult;
  composedPrompt: string;
  referenceFileIds: string[];
  origin: GenerateSource;
  createdBy: GenerateCreatedBy;
  lockKey: string;
}

/**
 * CanvasGenerateService。
 *  - recent: clientOpId 幂等缓存
 *  - inflight: lockKey → AbortController（per project+artifact 唯一进行中）
 */
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

  /** 面板路径：同步 prepare + complete。 */
  async generate(input: GenerateFromCanvasInput): Promise<GenerateFromCanvasResult> {
    const hit = this.recent.get(input.clientOpId);
    if (hit && hit.expiresAt > Date.now()) return hit.result;

    const prepared = await this.prepare(input);
    return this.complete(prepared, input.signal);
  }

  /**
   * 仅落 pending 卡 + 连线（同步）。Agent async 路径先调此方法再 return accepted。
   */
  async prepare(input: GenerateFromCanvasInput): Promise<PreparedGenerate> {
    const origin = input.source ?? "canvas_panel";
    const createdBy = input.createdBy ?? "designer";

    const snapshot = await this.desks.snapshot(input.projectId);
    const source = snapshot.artifacts.find((a) => a.id === input.sourceArtifactId);
    const sourceLayout = snapshot.deskState.objects.find((o) => o.artifact_id === input.sourceArtifactId);
    if (!source || !sourceLayout) throw new HttpError(404, "源物件不在桌面上");

    const inbound = snapshot.deskState.connections.filter((c) => c.to === input.sourceArtifactId);
    const extraRefIds = [...new Set((input.referenceArtifactIds ?? []).filter((id) => id && id !== input.sourceArtifactId))];
    const { referenceFileIds, noteTexts } = this.collectReferences(snapshot, source, inbound, extraRefIds);
    const composedPrompt = this.composePrompt(
      input.prompt,
      noteTexts,
      referenceFileIds.length < this.expectedImageRefs(snapshot, source, inbound, extraRefIds),
    );

    const preparedTarget = input.targetArtifactId
      ? await this.prepareRetryTarget(input, snapshot, composedPrompt, referenceFileIds, origin, createdBy, extraRefIds)
      : await this.prepareNewTarget(input, sourceLayout, composedPrompt, referenceFileIds, origin, createdBy, extraRefIds);

    const pending: GenerateFromCanvasResult = {
      artifact: { id: preparedTarget.artifactId },
      version: { id: preparedTarget.versionId, status: preparedTarget.versionStatus },
      object: preparedTarget.object,
      connection: preparedTarget.connection,
      status: "pending",
    };
    this.recent.set(input.clientOpId, { result: pending, expiresAt: Date.now() + 10 * 60 * 1000 });

    return {
      pending,
      composedPrompt,
      referenceFileIds,
      origin,
      createdBy,
      lockKey: `${input.projectId}:${input.targetArtifactId ?? input.sourceArtifactId}`,
    };
  }

  /**
   * 出图并写终态（可后台调用）。
   * 异常兜底：失败也写一版 payload.error 到 artifact，让前端能区分「进行中」和「失败」。
   * lockKey 互斥：同 project+artifact 的上一次 inflight 会被 abort。
   */
  async complete(prepared: PreparedGenerate, signal?: AbortSignal): Promise<GenerateFromCanvasResult> {
    const { pending, composedPrompt, referenceFileIds, origin, createdBy, lockKey } = prepared;
    const projectId = lockKey.split(":")[0];

    this.inflight.get(lockKey)?.abort();
    const controller = new AbortController();
    this.inflight.set(lockKey, controller);
    const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const referenceFiles = await this.loadReferenceFiles(projectId, referenceFileIds);
      const generated = await this.images.generate(
        {
          projectId,
          context: composedPrompt,
          intent: "canvas_panel",
          referenceFiles,
        },
        controller.signal,
      );
      const version = await this.artifacts.append(pending.artifact.id, {
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
      this.cacheResult(pending.artifact.id, done);
      return done;
    } catch (error) {
      const message = error instanceof Error
        ? (error.name === "AbortError" ? "生成已取消或超时" : error.message)
        : "生成失败";
      try {
        await this.artifacts.append(pending.artifact.id, {
          payload: { pending: false, prompt: composedPrompt, source: origin, error: message },
          inputRefs: referenceFileIds.map((file_id) => ({ file_id })),
          status: "draft",
          createdBy,
        });
      } catch {
        // best-effort
      }
      const failed: GenerateFromCanvasResult = { ...pending, status: "failed", error: message };
      this.cacheResult(pending.artifact.id, failed);
      return failed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
      if (this.inflight.get(lockKey) === controller) this.inflight.delete(lockKey);
    }
  }

  /** 中止某个（project, source）上的 inflight。 */
  abort(projectId: string, sourceArtifactId: string) {
    const key = `${projectId}:${sourceArtifactId}`;
    this.inflight.get(key)?.abort();
    this.inflight.delete(key);
  }

  /** 取消该项目所有进行中的生图（agent stop / 服务关停时调用）。 */
  abortProject(projectId: string) {
    const prefix = `${projectId}:`;
    for (const [key, controller] of this.inflight) {
      if (!key.startsWith(prefix)) continue;
      controller.abort();
      this.inflight.delete(key);
    }
  }

  /** 把最终结果回填到 recent 表里所有命中此 artifact 的 clientOpId（统一 finalize 状态）。 */
  private cacheResult(artifactId: string, result: GenerateFromCanvasResult) {
    for (const [clientOpId, entry] of this.recent) {
      if (entry.result.artifact.id === artifactId) {
        this.recent.set(clientOpId, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
      }
    }
  }

  private async prepareNewTarget(
    input: GenerateFromCanvasInput,
    sourceLayout: DeskLayoutObject,
    composedPrompt: string,
    referenceFileIds: string[],
    origin: GenerateSource,
    createdBy: GenerateCreatedBy,
    extraRefIds: string[] = [],
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
    const connection = await this.linkInputsToEffect(
      input.projectId,
      placed.artifact.id,
      input.sourceArtifactId,
      extraRefIds,
      input.clientOpId,
    );
    return {
      artifactId: placed.artifact.id,
      versionId: placed.version.id,
      versionStatus: placed.version.status,
      object: placed.object,
      connection,
    };
  }

  private async prepareRetryTarget(
    input: GenerateFromCanvasInput,
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    composedPrompt: string,
    referenceFileIds: string[],
    origin: GenerateSource,
    createdBy: GenerateCreatedBy,
    extraRefIds: string[] = [],
  ) {
    const targetId = input.targetArtifactId!;
    const target = snapshot.artifacts.find((a) => a.id === targetId);
    const targetLayout = snapshot.deskState.objects.find((o) => o.artifact_id === targetId);
    if (!target || !targetLayout) throw new HttpError(404, "重试目标不在桌面上");
    if (target.artifactType !== "effect_image") throw new HttpError(422, "只能在效果图上重试生成");

    const connection = await this.linkInputsToEffect(
      input.projectId,
      targetId,
      input.sourceArtifactId,
      extraRefIds,
      input.clientOpId,
    );

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

  /** 主源 + 每个参考 → 效果图各一条连线；返回主源连线（供 history 单条记录）。 */
  private async linkInputsToEffect(
    projectId: string,
    effectId: string,
    sourceArtifactId: string,
    extraRefIds: string[],
    clientOpId: string,
  ) {
    const fromIds = [sourceArtifactId, ...extraRefIds.filter((id) => id !== sourceArtifactId)];
    let primary: DeskConnection | undefined;
    for (let i = 0; i < fromIds.length; i++) {
      const from = fromIds[i];
      const connection = await this.desks.createConnection(
        projectId,
        from,
        effectId,
        `${clientOpId}:conn:${i}`,
      );
      if (from === sourceArtifactId) primary = connection;
      else if (!primary) primary = connection;
    }
    if (!primary) throw new HttpError(500, "连线创建失败");
    return primary;
  }

  /** 期望纳入 prompt 的图片参考数：源 + 入边 + 显式参考。 */
  private expectedImageRefs(
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    source: { id: string; artifactType: ArtifactType; payload: Record<string, unknown> },
    inbound: DeskConnection[],
    extraRefIds: string[] = [],
  ) {
    let n = 0;
    if ((source.artifactType === "canvas_image" || source.artifactType === "effect_image") && typeof source.payload.file_id === "string") n += 1;
    for (const edge of inbound) {
      const art = snapshot.artifacts.find((a) => a.id === edge.from);
      if (art && (art.artifactType === "canvas_image" || art.artifactType === "effect_image") && typeof art.payload.file_id === "string") n += 1;
    }
    for (const id of extraRefIds) {
      const art = snapshot.artifacts.find((a) => a.id === id);
      if (art && (art.artifactType === "canvas_image" || art.artifactType === "effect_image") && typeof art.payload.file_id === "string") n += 1;
    }
    return n;
  }

  /** 收集参考：源 + 入边 + 显式参考 id。图片入 referenceFileIds，便签文本入 noteTexts。 */
  private collectReferences(
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    source: { id: string; artifactType: ArtifactType; payload: Record<string, unknown> },
    inbound: DeskConnection[],
    extraRefIds: string[] = [],
  ) {
    const referenceFileIds: string[] = [];
    const noteTexts: string[] = [];
    const pushFile = (payload: Record<string, unknown>) => {
      const id = payload.file_id;
      if (typeof id === "string" && id && !referenceFileIds.includes(id)) referenceFileIds.push(id);
    };
    const pushArtifact = (art: { artifactType: ArtifactType; payload: Record<string, unknown> } | undefined) => {
      if (!art) return;
      if (art.artifactType === "canvas_image" || art.artifactType === "effect_image") pushFile(art.payload);
      if (art.artifactType === "sticky_note" && typeof art.payload.text === "string" && art.payload.text.trim()) {
        noteTexts.push(art.payload.text.trim());
      }
    };
    pushArtifact(source);
    for (const edge of inbound) {
      pushArtifact(snapshot.artifacts.find((a) => a.id === edge.from));
    }
    for (const id of extraRefIds) {
      pushArtifact(snapshot.artifacts.find((a) => a.id === id));
    }
    return { referenceFileIds, noteTexts };
  }

  /** 拼最终 prompt：用户原意 + 收集到的便签文本 + 缺图提示。空 prompt 兜底为「生成效果图」。 */
  private composePrompt(userPrompt: string, noteTexts: string[], missingRef: boolean) {
    const parts = [userPrompt.trim()].filter(Boolean);
    if (noteTexts.length > 0) parts.push(`参考要求：${noteTexts.join("；")}`);
    if (missingRef) parts.push("（有参考图缺失）");
    return parts.join("\n") || "生成效果图";
  }

  /** 把 fileIds 读出为 ReferenceFile 列表（缺一个跳一个，不阻断主流程）。 */
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
