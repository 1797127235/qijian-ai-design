import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { artifacts, artifactVersions, deskStates, projects, storedFiles } from "../db/schema.js";
import { artifactTypes, type DeskLayoutObject, type DeskSnapshot, type DeskViewport } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";

const defaultViewport: DeskViewport = { x: 40, y: 20, zoom: 0.62 };
const supportedArtifactTypes = new Set<string>(artifactTypes);

export class DeskStateService {
  constructor(private readonly db: Database) {}

  async listProjects() {
    const rows = await this.db.select().from(projects).orderBy(desc(projects.updatedAt));
    const summaries = await Promise.all(
      rows.map(async (project) => {
        const versions = await this.db
          .select({ artifactType: artifacts.artifactType, status: artifactVersions.status, payload: artifactVersions.payload })
          .from(artifacts)
          .innerJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
          .where(eq(artifacts.projectId, project.id));
        const effects = versions.filter((v) => v.artifactType === "effect_image" && typeof v.payload.url === "string");
        const cover = effects[0];
        return {
          ...project,
          effectCount: effects.length,
          coverUrl: typeof cover?.payload.url === "string" ? cover.payload.url : undefined,
        };
      }),
    );
    return summaries;
  }

  async createProject(name: string) {
    return this.db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({ name }).returning();
      await tx.insert(deskStates).values({ projectId: project.id, objects: [], viewport: defaultViewport });
      return project;
    });
  }

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
        viewport: state?.viewport ?? defaultViewport,
        updatedAt: state?.updatedAt ?? project.updatedAt,
      },
    };
  }

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

  async setViewport(projectId: string, viewport: DeskViewport) {
    const [state] = await this.db
      .update(deskStates)
      .set({ viewport, updatedAt: new Date() })
      .where(eq(deskStates.projectId, projectId))
      .returning();
    if (!state) throw new HttpError(404, "未找到该设计项目");
    return state.viewport;
  }

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

}
