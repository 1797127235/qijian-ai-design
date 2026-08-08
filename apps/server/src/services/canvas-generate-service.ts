import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { storedFiles } from "../db/schema.js";
import type { ArtifactType, DeskConnection, DeskLayoutObject } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { ArtifactService } from "./artifact-service.js";
import type { DeskStateService } from "./desk-state-service.js";
import type { FileStorage } from "./file-storage.js";
import { composeSideBySide, cropImage, type ImageRegion } from "./image-crop.js";
import type { ImageGenerator, ReferenceFile } from "./image-generator.js";

/**
 * 局部重绘的参考图组装（纯编排，便于单测）：
 *  - 有 region：裁剪源图（referenceFiles[0]，collectReferences 保证源在最前）替换整图
 *  - region + 上传参考图：「裁剪 | 参考」左右合成单张（grok edit 只收单图）
 *  - 只有上传参考图：参考图作为唯一 ref
 *  - 都没有：原样返回（整图生成回归路径）
 */
export async function buildInpaintReferences(input: {
  referenceFiles: ReferenceFile[];
  region?: ImageRegion;
  referenceFile?: ReferenceFile;
}): Promise<ReferenceFile[]> {
  const { referenceFiles, region, referenceFile } = input;
  if (region && referenceFiles.length > 0) {
    const source = referenceFiles[0];
    const cropped = await cropImage(source.bytes, source.mediaType, region);
    const croppedRef: ReferenceFile = { bytes: cropped, mediaType: "image/png", filename: "inpaint-region.png" };
    if (referenceFile) {
      const composed = await composeSideBySide(croppedRef, referenceFile);
      return [{ bytes: composed, mediaType: "image/png", filename: "inpaint-composed.png" }];
    }
    return [croppedRef];
  }
  if (referenceFile) return [referenceFile];
  return referenceFiles;
}

/** 去掉历史重试可能带回的局部重绘前缀，保证 compose 只加一次。 */
export function stripInpaintPrefix(prompt: string): string {
  return prompt.replace(/^(局部重绘：[^\n]*\n)+/, "").trim();
}

/** 用户原文 + 缺图提示 + 可选局部重绘前缀 → 模型上下文。 */
export function composeCanvasPrompt(input: {
  userPrompt: string;
  missingRef: boolean;
  region?: ImageRegion;
  hasReferenceFile?: boolean;
}): string {
  const parts = [stripInpaintPrefix(input.userPrompt)].filter(Boolean);
  if (input.missingRef) parts.push("（有参考图缺失）");
  const base = parts.join("\n") || "生成效果图";
  if (!input.region) return base;
  const dual = input.hasReferenceFile ? "左图为待修改区域，右图为参考图，按右图的物品/风格替换。" : "";
  return `局部重绘：只修改图中所选区域的内容，区域外保持原样。${dual}\n${base}`;
}

/** pending/终态 payload 共用字段：user_prompt 供重试，prompt 仍写 composed 供展示/审计。 */
function generationPayloadFields(input: {
  composedPrompt: string;
  userPrompt: string;
  origin: GenerateSource;
  region?: ImageRegion;
  referenceFileId?: string;
}) {
  return {
    prompt: input.composedPrompt,
    user_prompt: input.userPrompt,
    source: input.origin,
    ...(input.region ? { region: input.region, inpaint: true as const } : {}),
    ...(input.referenceFileId ? { reference_file_id: input.referenceFileId } : {}),
  };
}

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

/** 对用户/落库可见的错误文案：去掉路径、URL、堆栈等内部细节。 */
function publicGenerateError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "生成失败";
  if (/已取消|超时|Abort/.test(trimmed)) return "生成已取消或超时";
  if (/网络|timeout|ETIMEDOUT|ECONN/i.test(trimmed)) return "图像服务暂时不可用，请稍后重试";
  if (/尚未配置|IMAGE_API/.test(trimmed)) return "图像服务未配置";
  if (/超过 20MB|无法归档|无效响应|不支持|不允许的图片主机|图片类型/.test(trimmed)) {
    return trimmed.slice(0, 120);
  }
  return "生成失败，请稍后重试";
}

export type GenerateSource = "canvas_panel" | "agent_chat";
export type GenerateCreatedBy = "designer" | "agent";

export interface GenerateFromCanvasInput {
  projectId: string;
  sourceArtifactId: string;
  prompt: string;
  clientOpId: string;
  /**
   * 重试时传入已有失败/待生成的 effect_image id，或空占位 canvas_image id（生成结果直接填回该卡），
   * 在原卡上 append，不新建。省略则 createPlaced 新卡。
   */
  targetArtifactId?: string;
  /** 额外参考物件（不含主源）；与主源入边合并去重 */
  referenceArtifactIds?: string[];
  /** 默认 canvas_panel；Agent 工具传 agent_chat */
  source?: GenerateSource;
  createdBy?: GenerateCreatedBy;
  /** 局部重绘：归一化选区（0–1，源图本地坐标）。存在时裁剪源图作为参考 */
  region?: ImageRegion;
  /** 局部重绘：用户上传的参考图 fileId（须属于本项目） */
  referenceFileId?: string;
  /** 外部取消（agent stop / 工具 AbortSignal） */
  signal?: AbortSignal;
}

export interface GenerateFromCanvasResult {
  artifact: { id: string };
  version: { id: string; status: string };
  object: DeskLayoutObject;
  /** 新建效果图时的主源连线；填回已有卡（targetArtifactId）时可能不存在 */
  connection?: DeskConnection;
  status: "pending" | "succeeded" | "failed";
  error?: string;
}

/** prepare 阶段产物，供 Agent 异步 complete 使用。 */
export interface PreparedGenerate {
  pending: GenerateFromCanvasResult;
  composedPrompt: string;
  /** 用户原文（不含局部重绘前缀），落库 user_prompt 与重试回传 */
  userPrompt: string;
  referenceFileIds: string[];
  origin: GenerateSource;
  createdBy: GenerateCreatedBy;
  lockKey: string;
  /** 局部重绘透传：complete 时裁剪/合成 */
  region?: ImageRegion;
  referenceFileId?: string;
}

/**
 * CanvasGenerateService。
 *  - recent: clientOpId 幂等缓存
 *  - inflight: lockKey → AbortController（per project+artifact 唯一进行中）
 */
export class CanvasGenerateService {
  private readonly recent = new Map<string, { result: GenerateFromCanvasResult; expiresAt: number }>();
  private readonly inflightOps = new Map<string, Promise<GenerateFromCanvasResult>>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactService,
    private readonly desks: DeskStateService,
    private readonly files: FileStorage,
    private readonly images: ImageGenerator,
  ) {}

  private opKey(projectId: string, clientOpId: string) {
    return `${projectId}:${clientOpId}`;
  }

  /** 面板路径：同步 prepare + complete。 */
  async generate(input: GenerateFromCanvasInput): Promise<GenerateFromCanvasResult> {
    const key = this.opKey(input.projectId, input.clientOpId);
    const hit = this.recent.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.result;
    const existing = this.inflightOps.get(key);
    if (existing) return existing;

    const work = (async () => {
      const prepared = await this.prepare(input);
      return this.complete(prepared, input.signal);
    })().finally(() => {
      this.inflightOps.delete(key);
    });
    this.inflightOps.set(key, work);
    return work;
  }

  /**
   * 仅落 pending 卡 + 连线（同步）。Agent async 路径先调此方法再 return accepted。
   */
  async prepare(input: GenerateFromCanvasInput): Promise<PreparedGenerate> {
    const origin = input.source ?? "canvas_panel";
    const createdBy = input.createdBy ?? "designer";

    if (input.referenceFileId) {
      const [row] = await this.db
        .select({ id: storedFiles.id })
        .from(storedFiles)
        .where(and(eq(storedFiles.id, input.referenceFileId), eq(storedFiles.projectId, input.projectId)));
      if (!row) throw new HttpError(422, "参考图不存在于本项目中");
    }

    const snapshot = await this.desks.snapshot(input.projectId);
    const source = snapshot.artifacts.find((a) => a.id === input.sourceArtifactId);
    const sourceLayout = snapshot.deskState.objects.find((o) => o.artifact_id === input.sourceArtifactId);
    if (!source || !sourceLayout) throw new HttpError(404, "源物件不在桌面上");

    const inbound = snapshot.deskState.connections.filter((c) => c.to === input.sourceArtifactId);
    const extraRefIds = [...new Set((input.referenceArtifactIds ?? []).filter((id) => id && id !== input.sourceArtifactId))];
    const { referenceFileIds } = this.collectReferences(snapshot, source, inbound, extraRefIds);
    const userPrompt = stripInpaintPrefix(input.prompt);
    const composedPrompt = composeCanvasPrompt({
      userPrompt,
      missingRef: referenceFileIds.length < this.expectedImageRefs(snapshot, source, inbound, extraRefIds),
      region: input.region,
      hasReferenceFile: Boolean(input.referenceFileId),
    });
    const payloadFields = generationPayloadFields({
      composedPrompt,
      userPrompt,
      origin,
      region: input.region,
      referenceFileId: input.referenceFileId,
    });

    const preparedTarget = input.targetArtifactId
      ? await this.prepareRetryTarget(input, snapshot, referenceFileIds, createdBy, extraRefIds, payloadFields)
      : await this.prepareNewTarget(input, sourceLayout, referenceFileIds, createdBy, extraRefIds, payloadFields);

    const pending: GenerateFromCanvasResult = {
      artifact: { id: preparedTarget.artifactId },
      version: { id: preparedTarget.versionId, status: preparedTarget.versionStatus },
      object: preparedTarget.object,
      connection: preparedTarget.connection,
      status: "pending",
    };
    this.recent.set(this.opKey(input.projectId, input.clientOpId), {
      result: pending,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return {
      pending,
      composedPrompt,
      userPrompt,
      referenceFileIds,
      origin,
      createdBy,
      lockKey: `${input.projectId}:${input.targetArtifactId ?? input.sourceArtifactId}`,
      region: input.region,
      referenceFileId: input.referenceFileId,
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

    const payloadBase = generationPayloadFields({
      composedPrompt,
      userPrompt: prepared.userPrompt,
      origin,
      region: prepared.region,
      referenceFileId: prepared.referenceFileId,
    });
    const inputRefs = referenceFileIds.map((file_id) => ({ file_id }));

    try {
      const loaded = await this.loadReferenceFiles(projectId, referenceFileIds);
      let referenceFile: ReferenceFile | undefined;
      if (prepared.referenceFileId) {
        referenceFile = (await this.loadReferenceFiles(projectId, [prepared.referenceFileId]))[0];
        if (!referenceFile) throw new HttpError(422, "参考图不存在于本项目中");
      }
      const referenceFiles = await buildInpaintReferences({
        referenceFiles: loaded,
        region: prepared.region,
        referenceFile,
      });
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
          pending: false,
          source_url: generated.sourceUrl,
          ...payloadBase,
        },
        inputRefs,
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
      // 已被更新请求接管的 stale controller 不得再写失败版本
      if (this.inflight.get(lockKey) !== controller) {
        return { ...pending, status: "failed", error: "生成已取消或超时" };
      }
      const raw = error instanceof Error
        ? (error.name === "AbortError" ? "生成已取消或超时" : error.message)
        : "生成失败";
      const message = publicGenerateError(raw);
      try {
        await this.artifacts.append(pending.artifact.id, {
          payload: { pending: false, error: message, ...payloadBase },
          inputRefs,
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

  /** 中止 project 上 source 或 target 对应的 inflight（retry 用 target 作 lockKey）。 */
  abort(projectId: string, sourceOrTargetArtifactId: string) {
    const key = `${projectId}:${sourceOrTargetArtifactId}`;
    this.inflight.get(key)?.abort();
    this.inflight.delete(key);
    // 兼容：也扫一遍同 project 下仍以该 id 为 lock 后缀的项
    const prefix = `${projectId}:`;
    for (const [k, controller] of this.inflight) {
      if (k.startsWith(prefix) && k.endsWith(`:${sourceOrTargetArtifactId}`)) {
        controller.abort();
        this.inflight.delete(k);
      }
    }
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

  /** 把最终结果回填到 recent 表里所有命中此 artifact 的 key（统一 finalize 状态）。 */
  private cacheResult(artifactId: string, result: GenerateFromCanvasResult) {
    for (const [key, entry] of this.recent) {
      if (entry.result.artifact.id === artifactId) {
        this.recent.set(key, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
      }
    }
  }

  private async prepareNewTarget(
    input: GenerateFromCanvasInput,
    sourceLayout: DeskLayoutObject,
    referenceFileIds: string[],
    createdBy: GenerateCreatedBy,
    extraRefIds: string[],
    payloadFields: ReturnType<typeof generationPayloadFields>,
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
        payload: { pending: true, ...payloadFields },
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
    referenceFileIds: string[],
    createdBy: GenerateCreatedBy,
    extraRefIds: string[],
    payloadFields: ReturnType<typeof generationPayloadFields>,
  ) {
    const targetId = input.targetArtifactId!;
    const target = snapshot.artifacts.find((a) => a.id === targetId);
    const targetLayout = snapshot.deskState.objects.find((o) => o.artifact_id === targetId);
    if (!target || !targetLayout) throw new HttpError(404, "重试目标不在桌面上");
    if (target.artifactType !== "effect_image" && target.artifactType !== "canvas_image") {
      throw new HttpError(422, "只能在图片卡上重试生成");
    }

    const connection = await this.linkInputsToEffect(
      input.projectId,
      targetId,
      input.sourceArtifactId,
      extraRefIds,
      input.clientOpId,
    );

    const version = await this.artifacts.append(targetId, {
      payload: { pending: true, ...payloadFields },
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

  /** 主源 + 每个参考 → 效果图各一条连线；返回主源连线（供 history 单条记录）。target 与 from 相同（填回）时跳过自连。 */
  private async linkInputsToEffect(
    projectId: string,
    effectId: string,
    sourceArtifactId: string,
    extraRefIds: string[],
    clientOpId: string,
  ) {
    const fromIds = [sourceArtifactId, ...extraRefIds.filter((id) => id !== sourceArtifactId)]
      .filter((from) => from !== effectId);
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

  /** 收集参考：源 + 入边 + 显式参考 id。图片入 referenceFileIds。 */
  private collectReferences(
    snapshot: Awaited<ReturnType<DeskStateService["snapshot"]>>,
    source: { id: string; artifactType: ArtifactType; payload: Record<string, unknown> },
    inbound: DeskConnection[],
    extraRefIds: string[] = [],
  ) {
    const referenceFileIds: string[] = [];
    const pushFile = (payload: Record<string, unknown>) => {
      const id = payload.file_id;
      if (typeof id === "string" && id && !referenceFileIds.includes(id)) referenceFileIds.push(id);
    };
    const pushArtifact = (art: { artifactType: ArtifactType; payload: Record<string, unknown> } | undefined) => {
      if (!art) return;
      if (art.artifactType === "canvas_image" || art.artifactType === "effect_image") pushFile(art.payload);
    };
    pushArtifact(source);
    for (const edge of inbound) {
      pushArtifact(snapshot.artifacts.find((a) => a.id === edge.from));
    }
    for (const id of extraRefIds) {
      pushArtifact(snapshot.artifacts.find((a) => a.id === id));
    }
    return { referenceFileIds };
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
