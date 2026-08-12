import { and, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/client.js";
import { artifacts, artifactVersions, deskStates, projects, storedFiles } from "../db/schema.js";
import { DomainValidationError, assertPayload } from "../domain/payload-rules.js";
import { artifactTypes, type ArtifactStatus, type ArtifactType, type CreatedBy, type DeskLayoutObject } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import { contentHash } from "../lib/json.js";

/**
 * Artifact 服务：管理 artifact 与版本链、放置/移动/删除的桌面布局变化。
 *
 * 核心不变式：
 *  - artifactVersions 不可变（append-only），artifacts.current_version_id 是指针
 *  - inputRefs 记录该版本依赖的 file_id（PDF 带 page），用于引用追踪 / GC
 *  - 放置（createPlaced）= 新建 artifact + v1 + 写 desk_state.objects，单事务
 *  - 删除（deletePlaced）= 删 artifact 行（级联删 versions） + 同步清 desk_state.objects 与 connections
 *
 * 幂等性：createPlaced 接受 clientOpId，相同 id 在 10 分钟内返回同一结果（用于前端断网重试）。
 */
export interface AppendVersionInput {
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
  status?: ArtifactStatus;
  createdBy: CreatedBy;
  changeReason?: string;
}

export interface RestorePlacedInput {
  artifactId: string;
  artifactType: ArtifactType;
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
  createdBy: CreatedBy;
  layout: NewDeskObject;
}

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type NewDeskObject = Omit<DeskLayoutObject, "artifact_id">;

/** 画布图片可接受的 media_type（与 ALLOWED_UPLOAD_MEDIA_TYPES 不同——后者管上传，这里管落桌）。 */
const CANVAS_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png"]);
/** clientOpId 幂等窗口。 */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
/** 幂等表最大条目（超出按插入顺序淘汰最旧）。 */
const IDEMPOTENCY_MAX_ENTRIES = 500;

type CreatePlacedResult = {
  artifact: typeof artifacts.$inferSelect;
  version: typeof artifactVersions.$inferSelect;
  object: DeskLayoutObject;
};

/**
 * ArtifactService。
 * 持有进程内 recentPlacements 缓存（clientOpId → result），仅用于幂等，不持久化。
 */
export class ArtifactService {
  private readonly recentPlacements = new Map<string, { result: CreatePlacedResult; expiresAt: number }>();
  /** 进行中的幂等请求：project:clientOpId → Promise，防止并发双写 */
  private readonly inflightPlacements = new Map<string, Promise<CreatePlacedResult>>();
  /** 图片 ready 时后台 caption kick（可选，失败静默） */
  private onImageReady?: (projectId: string, fileId: string) => void;
  /** 桌面内容变更监听（封面调度等）。装配根注入；异常不影响主流程 */
  private deskChangedListener?: (projectId: string) => void;
  /** 物件硬删成功后（孤儿文件 GC 等）。装配根注入；异常不影响主流程 */
  private objectDeletedListener?: (projectId: string) => void;

  constructor(private readonly db: Database) {}

  setImageReadyHandler(handler: (projectId: string, fileId: string) => void) {
    this.onImageReady = handler;
  }

  setDeskChangedListener(listener: (projectId: string) => void) {
    this.deskChangedListener = listener;
  }

  setObjectDeletedListener(listener: (projectId: string) => void) {
    this.objectDeletedListener = listener;
  }

  private emitDeskChanged(projectId: string) {
    try {
      this.deskChangedListener?.(projectId);
    } catch {
      // 监听器异常不影响主流程
    }
  }

  private emitObjectDeleted(projectId: string) {
    try {
      this.objectDeletedListener?.(projectId);
    } catch {
      // 监听器异常不影响主流程
    }
  }

  private kickCaption(projectId: string, payload: Record<string, unknown>) {
    if (payload.pending === true) return;
    const fileId = payload.file_id;
    if (typeof fileId !== "string" || !fileId.trim()) return;
    try {
      this.onImageReady?.(projectId, fileId.trim());
    } catch {
      // caption 是增强，不抛
    }
  }

  private idempotencyKey(projectId: string, clientOpId: string) {
    return `${projectId}:${clientOpId}`;
  }

  /** 创建 artifact 但不落桌。 */
  async create(projectId: string, artifactType: ArtifactType, input: AppendVersionInput) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    return this.db.transaction((tx) => this.createInTransaction(tx, projectId, artifactType, input));
  }

  /**
   * 创建并落桌：写 artifact + v1 + desk_state.objects，单事务。
   * 接受 clientOpId 实现幂等：相同 project+id 在 IDEMPOTENCY_TTL_MS 内直接返回缓存结果。
   * 并发同 key 共享 in-flight Promise，避免双写。
   */
  async createPlaced(projectId: string, artifactType: ArtifactType, input: AppendVersionInput, layout: NewDeskObject, clientOpId?: string) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    const key = clientOpId ? this.idempotencyKey(projectId, clientOpId) : undefined;
    if (key) {
      const hit = this.recentPlacements.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.result;
      this.recentPlacements.delete(key);
      const inflight = this.inflightPlacements.get(key);
      if (inflight) return inflight;
    }
    const work = this.db.transaction((tx) => this.createPlacedInTransaction(tx, projectId, artifactType, input, layout)).then((result) => {
      if (key) this.rememberPlacement(key, result);
      this.kickCaption(projectId, input.payload);
      this.emitDeskChanged(projectId);
      return result;
    }).finally(() => {
      if (key) this.inflightPlacements.delete(key);
    });
    if (key) this.inflightPlacements.set(key, work);
    return work;
  }

  /** Same placement operation inside a caller-owned transaction (batch acceptance). */
  async createPlacedInTransaction(
    tx: DatabaseTransaction,
    projectId: string,
    artifactType: ArtifactType,
    input: AppendVersionInput,
    layout: NewDeskObject,
  ) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    const created = await this.createInTransaction(tx, projectId, artifactType, input);
    const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
    if (!state) throw new HttpError(404, "未找到该设计项目");
    const object: DeskLayoutObject = { artifact_id: created.artifact.id, ...layout };
    const objects = [...state.objects.filter((item) => item.artifact_id !== created.artifact.id), object];
    await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
    return { ...created, object };
  }

  /** 撤销删除：以原 UUID 重建 artifact（版本链从 v1 重启）并恢复桌面布局。 */
  async restorePlaced(projectId: string, input: RestorePlacedInput) {
    if (!artifactTypes.includes(input.artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(input.artifactType, input);
    return this.db.transaction(async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
      if (!project) throw new HttpError(404, "未找到该设计项目");
      const [existing] = await tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, input.artifactId));
      if (existing) throw new HttpError(409, "该 Artifact 已存在，无法重建");
      await this.validateInputRefs(tx, projectId, input.inputRefs ?? []);
      await this.validateCanvasImageFile(tx, projectId, input.artifactType, input.payload);
      const [artifact] = await tx
        .insert(artifacts)
        .values({ id: input.artifactId, projectId, artifactType: input.artifactType })
        .returning();
      const version = await this.insertVersion(tx, artifact.id, 1, input);
      await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const object: DeskLayoutObject = { artifact_id: artifact.id, ...input.layout };
      const objects = [...state.objects.filter((item) => item.artifact_id !== artifact.id), object];
      await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return { artifact, version, object };
    }).then((result) => {
      this.emitDeskChanged(projectId);
      return result;
    });
  }

  /** 删除桌面物件：单事务移除布局 + 级联连线 + 硬删 artifact（级联 versions）。 */
  async deletePlaced(projectId: string, artifactId: string) {
    return this.db.transaction(async (tx) => {
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const object = state.objects.find((item) => item.artifact_id === artifactId);
      if (!object) throw new HttpError(404, "该物件不在桌面上");
      const [artifact] = await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.projectId, projectId)));
      if (!artifact) throw new HttpError(404, "未找到该 Artifact");
      await tx.delete(artifacts).where(eq(artifacts.id, artifactId));
      const objects = state.objects.filter((item) => item.artifact_id !== artifactId);
      const connections = (state.connections ?? []).filter((c) => c.from !== artifactId && c.to !== artifactId);
      await tx.update(deskStates).set({ objects, connections, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return { object };
    }).then((result) => {
      this.emitDeskChanged(projectId);
      // 硬删后文件可能成孤儿；异步 GC（minAge 内跳过，不伤会话 undo）
      this.emitObjectDeleted(projectId);
      return result;
    });
  }

  /**
   * 追加新版本到现有 artifact，current_version_id 指针前移。
   * 继承上一版本的 inputRefs（未传时），保证 GC 引用图不断。
   */
  async append(
    artifactId: string,
    input: AppendVersionInput,
    options: { expectedCurrentVersion?: number } = {},
  ) {
    const result = await this.db.transaction((tx) =>
      this.appendInTransaction(tx, artifactId, input, options));
    this.kickCaption(result.projectId, input.payload);
    this.emitDeskChanged(result.projectId);
    return result.version;
  }

  async appendInTransaction(
    tx: DatabaseTransaction,
    artifactId: string,
    input: AppendVersionInput,
    options: { expectedCurrentVersion?: number } = {},
  ) {
    const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
    if (!artifact) throw new HttpError(404, "未找到该 Artifact");
    const [current] = artifact.currentVersionId
      ? await tx.select({
        inputRefs: artifactVersions.inputRefs,
        versionNo: artifactVersions.versionNo,
      }).from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId))
      : [];
    if (
      options.expectedCurrentVersion !== undefined
      && current?.versionNo !== options.expectedCurrentVersion
    ) {
      throw new HttpError(409, "目标图片版本已变化，已忽略迟到的生成结果");
    }
    const nextInput = { ...input, inputRefs: input.inputRefs ?? current?.inputRefs ?? [] };
    this.validateConfirmedPayload(artifact.artifactType as ArtifactType, nextInput);
    await this.validateInputRefs(tx, artifact.projectId, nextInput.inputRefs);
    await this.validateCanvasImageFile(tx, artifact.projectId, artifact.artifactType as ArtifactType, nextInput.payload);
    const [{ next }] = await tx
      .select({ next: max(artifactVersions.versionNo) })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId));
    const version = await this.insertVersion(tx, artifactId, (next ?? 0) + 1, nextInput);
    await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifactId));
    return { version, projectId: artifact.projectId };
  }

  /**
   * 回滚：current_version_id 指针后移到指定 versionId（不传则回到上一版）。
   * 数据不删，保留历史；前端看的是「指针指向的版本」。
   */
  async rollback(artifactId: string, versionId?: string) {
    let changedProjectId = "";
    const target = await this.db.transaction(async (tx) => {
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
      if (!artifact?.currentVersionId) throw new HttpError(404, "未找到该 Artifact");
      changedProjectId = artifact.projectId;
      const current = await tx.query.artifactVersions.findFirst({ where: eq(artifactVersions.id, artifact.currentVersionId) });
      const target = versionId
        ? await tx.query.artifactVersions.findFirst({
            where: and(eq(artifactVersions.id, versionId), eq(artifactVersions.artifactId, artifactId)),
          })
        : await tx.query.artifactVersions.findFirst({
            where: and(eq(artifactVersions.artifactId, artifactId), lt(artifactVersions.versionNo, current?.versionNo ?? 0)),
            orderBy: [desc(artifactVersions.versionNo)],
          });
      if (!current || !target) throw new HttpError(422, "没有可回滚的目标版本");
      await tx.update(artifacts).set({ currentVersionId: target.id }).where(eq(artifacts.id, artifactId));
      return target;
    });
    this.emitDeskChanged(changedProjectId);
    return target;
  }

  async current(artifactId: string) {
    return (await this.currentArtifact(artifactId)).version;
  }

  async currentArtifact(artifactId: string) {
    const [row] = await this.db
      .select({ artifact: artifacts, version: artifactVersions })
      .from(artifacts)
      .innerJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
      .where(eq(artifacts.id, artifactId));
    if (!row) throw new HttpError(404, "未找到该 Artifact");
    return row;
  }

  async getDisplayName(artifactId: string): Promise<{
    id: string;
    projectId: string;
    displayName: string | null;
    displayNameSource: string | null;
  }> {
    const [row] = await this.db
      .select({
        id: artifacts.id,
        projectId: artifacts.projectId,
        displayName: artifacts.displayName,
        displayNameSource: artifacts.displayNameSource,
      })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    if (!row) throw new HttpError(404, "未找到该 Artifact");
    return row;
  }

  /**
   * 设置人读展示名（artifacts 表列，与 version payload 分离，生图 complete 不会抹掉）。
   *
   * - source=user：总是写入；清空时 name=null 但 source 仍为 user，禁止后续 model 填空；
   *   同时抬升 displayNameVersion / 换 generationToken，使在途命名任务失效。
   * - source=model + force=false：仅当 display_name 仍为空且非 user 源。
   * - source=model + force=true：可覆盖 null/model（replace 强制重起名），永不覆盖 user。
   */
  async setDisplayName(
    artifactId: string,
    name: string | null,
    source: "user" | "model",
    opts?: { force?: boolean },
  ): Promise<{ id: string; projectId: string; displayName: string | null; displayNameSource: string | null }> {
    const trimmed = name === null ? null : name.trim().replace(/\s+/g, " ").slice(0, 32) || null;
    const now = new Date();

    if (source === "user") {
      const [row] = await this.db
        .update(artifacts)
        .set({
          displayName: trimmed,
          displayNameSource: "user",
          displayNameUpdatedAt: now,
          displayNameVersion: sql`${artifacts.displayNameVersion} + 1`,
          displayNameGenerationToken: randomUUID(),
        })
        .where(eq(artifacts.id, artifactId))
        .returning({
          id: artifacts.id,
          projectId: artifacts.projectId,
          displayName: artifacts.displayName,
          displayNameSource: artifacts.displayNameSource,
        });
      if (!row) throw new HttpError(404, "未找到该 Artifact");
      this.emitDeskChanged(row.projectId);
      return row;
    }

    const force = opts?.force === true;
    const where = force
      ? and(
        eq(artifacts.id, artifactId),
        sql`(${artifacts.displayNameSource} IS NULL OR ${artifacts.displayNameSource} = 'model')`,
      )
      : and(
        eq(artifacts.id, artifactId),
        sql`${artifacts.displayName} IS NULL`,
        sql`(${artifacts.displayNameSource} IS NULL OR ${artifacts.displayNameSource} IS DISTINCT FROM 'user')`,
      );

    const [row] = await this.db
      .update(artifacts)
      .set({
        displayName: trimmed,
        displayNameSource: trimmed === null ? null : "model",
        displayNameUpdatedAt: now,
      })
      .where(where)
      .returning({
        id: artifacts.id,
        projectId: artifacts.projectId,
        displayName: artifacts.displayName,
        displayNameSource: artifacts.displayNameSource,
      });
    if (row) {
      this.emitDeskChanged(row.projectId);
      return row;
    }
    return this.getDisplayName(artifactId);
  }

  /**
   * 入队命名前调用：签发 generation_token 并抬升 name_version。
   * 返回 undefined 表示不应起名（用户已命名、或已有 model 名且非 force）。
   * 快照里的 displayNameSource 供 apply 时匹配「当时预期」的 source 条件。
   */
  async prepareModelDisplayName(
    artifactId: string,
    force = false,
  ): Promise<{
    artifactId: string;
    projectId: string;
    artifactVersionId: string;
    nameVersion: number;
    generationToken: string;
    displayNameSource: "system" | "model";
  } | undefined> {
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx.select().from(artifacts)
        .where(eq(artifacts.id, artifactId)).for("update");
      if (!artifact?.currentVersionId) return undefined;
      if (artifact.displayNameSource === "user") return undefined;
      if (!force && artifact.displayName) return undefined;
      const generationToken = randomUUID();
      const nameVersion = artifact.displayNameVersion + 1;
      await tx.update(artifacts).set({
        displayNameVersion: nameVersion,
        displayNameGenerationToken: generationToken,
      }).where(eq(artifacts.id, artifactId));
      return {
        artifactId: artifact.id,
        projectId: artifact.projectId,
        artifactVersionId: artifact.currentVersionId,
        nameVersion,
        generationToken,
        displayNameSource: artifact.displayNameSource === "model" ? "model" : "system",
      };
    });
  }

  /**
   * Worker 写回模型名：必须同时匹配 name_version + generation_token。
   * 任一条件失败返回 false（迟到任务 / 用户已改名），不抛错。
   */
  async applyGeneratedDisplayName(input: {
    artifactId: string;
    name: string;
    nameVersion: number;
    generationToken: string;
    /**
     * prepare 快照（task.display_name_source）：匹配「入队时」列上 source。
     * system ≈ 列 null；model ≈ 列 model。与 writeSource 分离。
     */
    displayNameSource: "system" | "model";
    /** 实际写入列：model=LLM，system=启发式兜底。默认 model（兼容旧调用）。 */
    writeSource?: "system" | "model";
    force?: boolean;
  }): Promise<boolean> {
    const writeSource = input.writeSource ?? "model";
    // force：覆盖 null/model/system，永不碰 user；非 force：按 prepare 快照匹配
    const expectedSource = input.force
      ? sql`(${artifacts.displayNameSource} IS NULL OR ${artifacts.displayNameSource} IN ('model', 'system'))`
      : input.displayNameSource === "model"
        ? eq(artifacts.displayNameSource, "model")
        : sql`${artifacts.displayNameSource} IS NULL`;
    const writableName = input.force ? sql`true` : sql`${artifacts.displayName} IS NULL`;
    const [row] = await this.db.update(artifacts).set({
      displayName: input.name.trim().slice(0, 32),
      displayNameSource: writeSource,
      displayNameUpdatedAt: new Date(),
    }).where(and(
      eq(artifacts.id, input.artifactId),
      eq(artifacts.displayNameVersion, input.nameVersion),
      eq(artifacts.displayNameGenerationToken, input.generationToken),
      sql`${artifacts.displayNameSource} IS DISTINCT FROM 'user'`,
      expectedSource,
      writableName,
    )).returning({ projectId: artifacts.projectId });
    if (row) this.emitDeskChanged(row.projectId);
    return Boolean(row);
  }

  /**
   * 作废在途命名：抬升 version/token；可选清空非 user 的 display_name。
   * 用于取消/失败旁落等需要丢弃旧 model 名的场景。
   */
  async invalidateModelDisplayName(artifactId: string, clearModelName = false): Promise<void> {
    const [row] = await this.db.update(artifacts).set({
      displayNameVersion: sql`${artifacts.displayNameVersion} + 1`,
      displayNameGenerationToken: randomUUID(),
      ...(clearModelName ? { displayName: null, displayNameSource: null } : {}),
      displayNameUpdatedAt: new Date(),
    }).where(and(
      eq(artifacts.id, artifactId),
      ...(clearModelName ? [sql`${artifacts.displayNameSource} IS DISTINCT FROM 'user'`] : []),
    )).returning({ projectId: artifacts.projectId });
    if (row) this.emitDeskChanged(row.projectId);
  }

  /** 仅清除 source=model 的名（例如旁落失败卡）；source=user 不动。 */
  async clearModelDisplayName(artifactId: string): Promise<void> {
    const [row] = await this.db
      .update(artifacts)
      .set({
        displayName: null,
        displayNameSource: null,
        displayNameUpdatedAt: new Date(),
      })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.displayNameSource, "model")))
      .returning({ projectId: artifacts.projectId });
    if (row) this.emitDeskChanged(row.projectId);
  }

  /**
   * artifact 是否引用 fileId？查两个地方：
   *  1) artifact_versions.inputRefs[*].file_id（结构化引用）
   *  2) artifact_versions.payload.file_id / payload.pdf_file（payload 内嵌，向后兼容）
   * 用 jsonb_array_elements 在 SQL 内做引用检查，避免把所有版本拉回应用层。
   */
  async referencesFile(fileId: string, executor: Pick<Database, "select"> = this.db): Promise<boolean> {
    // 结构化引用优先：input_refs 中的 file_id；payload 内嵌 file_id 作兼容（如 canvas_image.payload.file_id）。
    const [hit] = await executor
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(sql`(
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${artifactVersions.inputRefs}) = 'array' THEN ${artifactVersions.inputRefs} ELSE '[]'::jsonb END) AS ref
          WHERE ref->>'file_id' = ${fileId}
        )
        OR ${artifactVersions.payload}->>'file_id' = ${fileId}
        OR ${artifactVersions.payload}->>'pdf_file' = ${fileId}
        OR ${artifactVersions.payload}->>'reference_file_id' = ${fileId}
      )`)
      .limit(1);
    return Boolean(hit);
  }

  /** 写幂等缓存：key 已含 project 前缀。先扫过期，超容量淘汰最旧。 */
  private rememberPlacement(key: string, result: CreatePlacedResult) {
    const now = Date.now();
    for (const [entryKey, entry] of this.recentPlacements) {
      if (entry.expiresAt <= now) this.recentPlacements.delete(entryKey);
    }
    if (this.recentPlacements.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.recentPlacements.keys().next().value;
      if (oldest !== undefined) this.recentPlacements.delete(oldest);
    }
    this.recentPlacements.set(key, { result, expiresAt: now + IDEMPOTENCY_TTL_MS });
  }

  /** canvas_image / effect_image 的 file_id 必须归属当前项目且为 JPEG/PNG。FOR UPDATE 与删除互斥。 */
  private async validateCanvasImageFile(
    tx: DatabaseTransaction,
    projectId: string,
    artifactType: ArtifactType,
    payload: Record<string, unknown>,
  ) {
    if (artifactType !== "canvas_image" && artifactType !== "effect_image") return;
    const fileId = payload.file_id;
    if (typeof fileId !== "string" || fileId.trim().length === 0) return;
    const [file] = await tx
      .select({ id: storedFiles.id, mediaType: storedFiles.mediaType })
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.projectId, projectId)))
      .for("update");
    if (!file) throw new HttpError(422, "图片文件不属于当前项目");
    if (!CANVAS_IMAGE_MEDIA_TYPES.has(file.mediaType)) {
      throw new HttpError(422, "画布图片仅支持 JPEG/PNG");
    }
  }

  /**
   * 校验 inputRefs 中所有 file_id 归属当前项目；若带 page 字段则 page ≤ 文件 pageCount。
   * SELECT … FOR UPDATE：与 deleteUnattached 串行，防止引用写入与删除交叉。
   */
  private async validateInputRefs(
    tx: DatabaseTransaction,
    projectId: string,
    inputRefs: unknown[],
  ) {
    const fileIds = [...new Set(inputRefs.flatMap((ref) => {
      if (!ref || typeof ref !== "object") return [];
      const fileId = (ref as Record<string, unknown>).file_id;
      return typeof fileId === "string" ? [fileId] : [];
    }))].sort();
    if (fileIds.length === 0) return;
    if (fileIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      throw new HttpError(422, "文件引用 ID 格式不正确");
    }
    // 排序后加锁，降低多文件并发时的死锁概率
    const owned = await tx
      .select({ id: storedFiles.id, pageCount: storedFiles.pageCount })
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, fileIds)))
      .for("update");
    if (owned.length !== fileIds.length) throw new HttpError(422, "存在不属于当前项目的文件引用");
    const pageCountById = new Map(owned.map((file) => [file.id, file.pageCount]));
    for (const ref of inputRefs) {
      if (!ref || typeof ref !== "object") continue;
      const value = ref as Record<string, unknown>;
      if (value.page === undefined) continue;
      if (typeof value.file_id !== "string" || !Number.isInteger(value.page) || (value.page as number) < 1) {
        throw new HttpError(422, "文件页码引用格式不正确");
      }
      const pageCount = pageCountById.get(value.file_id);
      if (!pageCount || (value.page as number) > pageCount) throw new HttpError(422, "文件页码超出 PDF 实际页数");
    }
  }

  private validateConfirmedPayload(artifactType: ArtifactType, input: AppendVersionInput) {
    try {
      assertPayload(artifactType, input.payload);
    } catch (error) {
      if (error instanceof DomainValidationError) throw new HttpError(422, error.message);
      throw error;
    }
  }

  private async createInTransaction(
    tx: DatabaseTransaction,
    projectId: string,
    artifactType: ArtifactType,
    input: AppendVersionInput,
  ) {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new HttpError(404, "未找到该设计项目");
    await this.validateInputRefs(tx, projectId, input.inputRefs ?? []);
    await this.validateCanvasImageFile(tx, projectId, artifactType, input.payload);
    const [artifact] = await tx.insert(artifacts).values({ projectId, artifactType }).returning();
    const version = await this.insertVersion(tx, artifact.id, 1, input);
    await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
    return { artifact, version };
  }

  private async insertVersion(
    tx: DatabaseTransaction,
    artifactId: string,
    versionNo: number,
    input: AppendVersionInput,
  ) {
    const inputRefs = input.inputRefs ?? [];
    const [version] = await tx
      .insert(artifactVersions)
      .values({
        artifactId,
        versionNo,
        payload: input.payload,
        inputRefs,
        status: input.status ?? "draft",
        createdBy: input.createdBy,
        changeReason: input.changeReason,
        contentHash: contentHash(input.payload, inputRefs),
      })
      .returning();
    return version;
  }
}
