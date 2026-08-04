import { and, desc, eq, inArray, lt, max } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { artifacts, artifactVersions, projects, storedFiles } from "../db/schema.js";
import { artifactTypes, type ArtifactStatus, type ArtifactType, type CreatedBy } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import { contentHash } from "../lib/json.js";

export interface AppendVersionInput {
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
  status?: ArtifactStatus;
  createdBy: CreatedBy;
  changeReason?: string;
}

export class ArtifactService {
  constructor(private readonly db: Database) {}

  async create(projectId: string, artifactType: ArtifactType, input: AppendVersionInput) {
    if (!artifactTypes.includes(artifactType)) throw new HttpError(422, "不支持的 Artifact 类型");
    this.validateConfirmedPayload(artifactType, input);
    return this.db.transaction(async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
      if (!project) throw new HttpError(404, "未找到该设计项目");
      await this.validateInputRefs(tx, projectId, input.inputRefs ?? []);
      const [artifact] = await tx.insert(artifacts).values({ projectId, artifactType }).returning();
      const version = await this.insertVersion(tx, artifact.id, 1, input);
      await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
      return { artifact, version };
    });
  }

  async append(artifactId: string, input: AppendVersionInput) {
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
      if (!artifact) throw new HttpError(404, "未找到该 Artifact");
      this.validateConfirmedPayload(artifact.artifactType as ArtifactType, input);
      await this.validateInputRefs(tx, artifact.projectId, input.inputRefs ?? []);
      const [{ next }] = await tx
        .select({ next: max(artifactVersions.versionNo) })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifactId));
      const version = await this.insertVersion(tx, artifactId, (next ?? 0) + 1, input);
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

  private async validateInputRefs(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
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
      .select({ id: storedFiles.id })
      .from(storedFiles)
      .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, fileIds)));
    if (owned.length !== fileIds.length) throw new HttpError(422, "存在不属于当前项目的文件引用");
  }

  private validateConfirmedPayload(artifactType: ArtifactType, input: AppendVersionInput) {
    if (input.status !== "confirmed") return;
    const payload = input.payload;
    const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    if (artifactType === "design_brief" && !nonEmpty(payload.text)) throw new HttpError(422, "确认 design_brief 前必须填写内容");
    if (artifactType === "space_map") {
      const spaces = Array.isArray(payload.spaces) ? payload.spaces : Array.isArray(payload.regions) ? payload.regions : [];
      if (spaces.length === 0) throw new HttpError(422, "确认 space_map 前必须标注空间区域");
    }
    if (artifactType === "understanding_note" && !nonEmpty(payload.text)) throw new HttpError(422, "理解便签内容不能为空");
    if (artifactType === "design_directions") {
      const directions = Array.isArray(payload.directions) ? payload.directions : [];
      const selected = payload.selected_direction_id;
      const selectedExists = directions.some((direction) => direction && typeof direction === "object" && (direction as Record<string, unknown>).id === selected);
      if (directions.length !== 3 || !selectedExists) throw new HttpError(422, "确认 design_directions 前必须从三个方向中选择一个");
    }
    if (artifactType === "effect_image" && !nonEmpty(payload.url)) throw new HttpError(422, "effect_image 必须包含图片 URL");
    if (artifactType === "proposal_package" && !payload.pdf_file && !payload.pdf_path) throw new HttpError(422, "proposal_package 必须包含 PDF 文件引用");
  }

  private async insertVersion(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
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
