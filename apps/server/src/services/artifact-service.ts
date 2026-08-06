import { and, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { artifacts, artifactVersions, deskStates, projects, storedFiles } from "../db/schema.js";
import { DomainValidationError, assertConfirmable } from "../domain/payload-rules.js";
import { artifactTypes, type ArtifactStatus, type ArtifactType, type CreatedBy, type DeskLayoutObject } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import { contentHash } from "../lib/json.js";

export interface AppendVersionInput {
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
  status?: ArtifactStatus;
  createdBy: CreatedBy;
  changeReason?: string;
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type NewDeskObject = Omit<DeskLayoutObject, "artifact_id">;

export class ArtifactService {
  constructor(private readonly db: Database) {}

  async create(projectId: string, artifactType: ArtifactType, input: AppendVersionInput) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    return this.db.transaction((tx) => this.createInTransaction(tx, projectId, artifactType, input));
  }

  async createPlaced(projectId: string, artifactType: ArtifactType, input: AppendVersionInput, layout: NewDeskObject) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    return this.db.transaction(async (tx) => {
      const result = await this.createInTransaction(tx, projectId, artifactType, input);
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const object: DeskLayoutObject = { artifact_id: result.artifact.id, ...layout };
      const objects = [...state.objects.filter((item) => item.artifact_id !== result.artifact.id), object];
      await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return { ...result, object };
    });
  }

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
      const [{ next }] = await tx
        .select({ next: max(artifactVersions.versionNo) })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifactId));
      const version = await this.insertVersion(tx, artifactId, (next ?? 0) + 1, nextInput);
      await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifactId));
      return version;
    });
  }

  async confirm(artifactId: string, createdBy: CreatedBy = "designer") {
    const current = await this.current(artifactId);
    if (current.status === "confirmed") return current;
    return this.append(artifactId, {
      payload: current.payload,
      inputRefs: current.inputRefs,
      status: "confirmed",
      createdBy,
      changeReason: "确认当前内容",
    });
  }

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

  async referencesFile(fileId: string): Promise<boolean> {
    // 结构化引用优先：input_refs 中的 file_id；payload 内嵌 id 作兼容（如 effect_image.file_id）。
    const [hit] = await this.db
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

  private async validateInputRefs(
    tx: DatabaseTransaction,
    projectId: string,
    inputRefs: unknown[],
  ) {
    const fileIds = [...new Set(inputRefs.flatMap((ref) => {
      if (!ref || typeof ref !== "object") return [];
      const fileId = (ref as Record<string, unknown>).file_id;
      return typeof fileId === "string" ? [fileId] : [];
    }))];
    if (fileIds.length === 0) return;
    if (fileIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      throw new HttpError(422, "文件引用 ID 格式不正确");
    }
    const owned = await tx
      .select({ id: storedFiles.id, pageCount: storedFiles.pageCount })
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, fileIds)));
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
    if (input.status !== "confirmed") return;
    try {
      assertConfirmable(artifactType, input.payload);
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
