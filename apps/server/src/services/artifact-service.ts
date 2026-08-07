import { and, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
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

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
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

  constructor(private readonly db: Database) {}

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
    const work = this.db.transaction(async (tx) => {
      const created = await this.createInTransaction(tx, projectId, artifactType, input);
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const object: DeskLayoutObject = { artifact_id: created.artifact.id, ...layout };
      const objects = [...state.objects.filter((item) => item.artifact_id !== created.artifact.id), object];
      await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return { ...created, object };
    }).then((result) => {
      if (key) this.rememberPlacement(key, result);
      return result;
    }).finally(() => {
      if (key) this.inflightPlacements.delete(key);
    });
    if (key) this.inflightPlacements.set(key, work);
    return work;
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
    });
  }

  /**
   * 追加新版本到现有 artifact，current_version_id 指针前移。
   * 继承上一版本的 inputRefs（未传时），保证 GC 引用图不断。
   */
  async append(artifactId: string, input: AppendVersionInput) {
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
      if (!artifact) throw new HttpError(404, "未找到该 Artifact");
      const [current] = artifact.currentVersionId
        ? await tx.select({ inputRefs: artifactVersions.inputRefs }).from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId))
        : [];
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
      return version;
    });
  }

  /**
   * 回滚：current_version_id 指针后移到指定 versionId（不传则回到上一版）。
   * 数据不删，保留历史；前端看的是「指针指向的版本」。
   */
  async rollback(artifactId: string, versionId?: string) {
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
      if (!artifact?.currentVersionId) throw new HttpError(404, "未找到该 Artifact");
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
