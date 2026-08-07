/**
 * 桌面状态服务：项目 CRUD、布局/视口/连线的修改、整体快照。
 *
 *  实体关系：projects 1:1 desk_states 1:N desk_layout_objects（jsonb 数组内嵌）
 *  不做流程关卡：放置/连线/删除都是即时生效，不走审批
 */
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/client.js";
import { artifacts, artifactVersions, deskStates, projects, storedFiles } from "../db/schema.js";
import { artifactTypes, type DeskConnection, type DeskLayoutObject, type DeskSnapshot, type DeskViewport } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";

/** 桌面首次打开时的视口默认值（偏左上、缩 0.62）。 */
const defaultViewport: DeskViewport = { x: 40, y: 20, zoom: 0.62 };
/** 允许出现在 snapshot.artifacts 的 artifact_type 集合；其他类型（如历史遗留）会被过滤。 */
const supportedArtifactTypes = new Set<string>(artifactTypes);

/**
 * 连线规范化：拒自连、端点不存在、已存在则返回 existing（幂等）。
 * 设计成纯函数方便单测和复用。
 */
export function normalizeConnection(
  from: string,
  to: string,
  existing: DeskConnection[],
  objectIds: Set<string>,
): { ok: true; connection?: DeskConnection; existing?: DeskConnection } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: "不能连接到自身" };
  if (!objectIds.has(from) || !objectIds.has(to)) return { ok: false, reason: "连线端点不在桌面上" };
  const dup = existing.find((c) => c.from === from && c.to === to);
  if (dup) return { ok: true, existing: dup };
  return { ok: true, connection: { id: randomUUID(), from, to } };
}

export class DeskStateService {
  constructor(private readonly db: Database) {}

  /** 列出所有项目（按 updatedAt 倒序，前端首页用）。 */
  async listProjects() {
    return this.db.select().from(projects).orderBy(desc(projects.updatedAt));
  }

  /** 轻量存在性检查（WS upgrade / 鉴权前使用，避免 snapshot 全量加载）。 */
  async projectExists(projectId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    return Boolean(row);
  }

  /** 新建项目同时插入 desk_state 单行（事务保证一致性，避免空状态查询）。 */
  async createProject(name: string) {
    return this.db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({ name }).returning();
      await tx.insert(deskStates).values({ projectId: project.id, objects: [], connections: [], viewport: defaultViewport });
      return project;
    });
  }

  /**
   * 删项目：级联删 projects 行（chat/artifact/stored_file 全部 onDelete: cascade），
   * 返回被删文件 objectKey 列表，让 routes 层负责 rm 磁盘。
   */
  async deleteProject(projectId: string) {
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new HttpError(404, "未找到该设计项目");
    const files = await this.db
      .select({ objectKey: storedFiles.objectKey })
      .from(storedFiles)
      .where(eq(storedFiles.projectId, projectId));
    await this.db.delete(projects).where(eq(projects.id, projectId));
    return { objectKeys: files.map((f) => f.objectKey) };
  }

  /**
   * 一次性返回 project + 全部 artifact 当前版本 + desk_state。
   * 是 Agent / 前端 GET /desk 的主数据源，单次往返避免拼装竞态。
   * 只返回 supportedArtifactTypes 内的类型（其他历史遗留类型自动丢弃）。
   */
  async snapshot(projectId: string): Promise<DeskSnapshot> {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new HttpError(404, "未找到该设计项目");
    const [state] = await this.db.select().from(deskStates).where(eq(deskStates.projectId, projectId));
    const rows = await this.db
      .select({ artifact: artifacts, version: artifactVersions })
      .from(artifacts)
      .innerJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
      .where(eq(artifacts.projectId, projectId));
    return {
      project: { id: project.id, name: project.name },
      artifacts: rows.flatMap(({ artifact, version }) => supportedArtifactTypes.has(artifact.artifactType)
        ? [{
            id: artifact.id,
            artifactType: artifact.artifactType as DeskSnapshot["artifacts"][number]["artifactType"],
            versionId: version.id,
            versionNo: version.versionNo,
            status: version.status as "draft" | "confirmed",
            payload: version.payload,
            inputRefs: version.inputRefs,
            createdBy: version.createdBy,
            createdAt: version.createdAt,
          }]
        : []),
      deskState: {
        objects: state?.objects ?? [],
        connections: state?.connections ?? [],
        viewport: state?.viewport ?? defaultViewport,
        updatedAt: state?.updatedAt ?? project.updatedAt,
      },
    };
  }

  /** 放置 / 移动一个物件（upsert 语义：同 artifact_id 覆盖）。 */
  async placeObject(projectId: string, object: DeskLayoutObject) {
    return this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, object.artifact_id), eq(artifacts.projectId, projectId)));
      if (!owned) throw new HttpError(422, "Artifact 不存在或不属于当前项目");
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const objects = [...state.objects.filter((item) => item.artifact_id !== object.artifact_id), object];
      await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return object;
    });
  }

  /** 视口持久化（前端画布缩放/平移时频繁调用，PATCH /desk 走这里）。 */
  async setViewport(projectId: string, viewport: DeskViewport) {
    const [state] = await this.db
      .update(deskStates)
      .set({ viewport, updatedAt: new Date() })
      .where(eq(deskStates.projectId, projectId))
      .returning();
    if (!state) throw new HttpError(404, "未找到该设计项目");
    return state.viewport;
  }

  /** 局部更新（拖动只改 x/y，缩放改 w，旋转改 rot）。patch 中只传要改的字段。 */
  async moveObject(projectId: string, artifactId: string, patch: Partial<Pick<DeskLayoutObject, "x" | "y" | "rot" | "w">>) {
    return this.db.transaction(async (tx) => {
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      let found = false;
      const objects = state.objects.map((object) => {
        if (object.artifact_id !== artifactId) return object;
        found = true;
        return { ...object, ...patch };
      });
      if (!found) throw new HttpError(404, "桌面上没有该物件");
      await tx.update(deskStates).set({ objects, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return objects.find((object) => object.artifact_id === artifactId)!;
    });
  }

  /**
   * 创建连线：归一化检查 + 幂等（重复同 from→to 直接返回 existing；指定 connectionId 已存在也返回）。
   * clientOpId 当前未直接使用（用 connectionId 做幂等键），保留形参避免破坏 Agent 调用方。
   */
  async createConnection(projectId: string, from: string, to: string, clientOpId?: string, connectionId?: string) {
    return this.db.transaction(async (tx) => {
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const objectIds = new Set(state.objects.map((o) => o.artifact_id));
      const result = normalizeConnection(from, to, state.connections ?? [], objectIds);
      if (!result.ok) throw new HttpError(422, result.reason);
      if (result.existing) return result.existing;
      const connection: DeskConnection = connectionId
        ? { id: connectionId, from, to }
        : result.connection!;
      // 若指定 id 已存在则幂等返回
      const byId = (state.connections ?? []).find((c) => c.id === connection.id);
      if (byId) return byId;
      const connections = [...(state.connections ?? []), connection];
      await tx.update(deskStates).set({ connections, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return connection;
    });
  }

  async deleteConnection(projectId: string, connectionId: string) {
    return this.db.transaction(async (tx) => {
      const [state] = await tx.select().from(deskStates).where(eq(deskStates.projectId, projectId)).for("update");
      if (!state) throw new HttpError(404, "未找到该设计项目");
      const connection = (state.connections ?? []).find((c) => c.id === connectionId);
      if (!connection) throw new HttpError(404, "未找到该连线");
      const connections = (state.connections ?? []).filter((c) => c.id !== connectionId);
      await tx.update(deskStates).set({ connections, updatedAt: new Date() }).where(eq(deskStates.projectId, projectId));
      return { connection };
    });
  }
}
