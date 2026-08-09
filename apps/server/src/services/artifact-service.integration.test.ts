import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { artifacts, storedFiles } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ArtifactService } from "./artifact-service.js";
import { DeskStateService } from "./desk-state-service.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL ?? "postgresql://qijian:qijian@localhost:5433/qijian";

let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  await created.db.select({ id: artifacts.id }).from(artifacts).limit(1);
  db = created.db;
  pool = created.pool;
  available = true;
} catch {
  console.warn("[integration] postgres unavailable at", DATABASE_URL, "— skipping");
}

const service = available ? new ArtifactService(db!) : (null as unknown as ArtifactService);
const desks = available ? new DeskStateService(db!) : (null as unknown as DeskStateService);

afterAll(async () => {
  if (pool) await pool.end();
});

const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

async function seedFile(projectId: string, mediaType: string) {
  const [file] = await db!
    .insert(storedFiles)
    .values({
      projectId,
      originalFilename: `seed.${mediaType === "application/pdf" ? "pdf" : "png"}`,
      mediaType,
      sizeBytes: 10,
      contentHash: `hash-${crypto.randomUUID()}`,
      objectKey: `${projectId}/${crypto.randomUUID()}.bin`,
    })
    .returning();
  return file;
}

describe("ArtifactService placed-object lifecycle (integration)", () => {
  itDb("createPlaced is idempotent per clientOpId", async () => {
    const project = await desks.createProject("it-idempotent");
    try {
      const layout = { kind: "canvas_image", x: 10, y: 20, rot: 0 };
      const first = await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, layout, "op-1");
      const second = await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, layout, "op-1");
      expect(second.artifact.id).toBe(first.artifact.id);
      const snapshot = await desks.snapshot(project.id);
      expect(snapshot.deskState.objects).toHaveLength(1);
      expect(snapshot.artifacts).toHaveLength(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("retries with a different clientOpId create separate artifacts", async () => {
    const project = await desks.createProject("it-not-idempotent");
    try {
      const layout = { kind: "canvas_image", x: 0, y: 0, rot: 0 };
      await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, layout, "op-a");
      await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, layout, "op-b");
      const snapshot = await desks.snapshot(project.id);
      expect(snapshot.artifacts).toHaveLength(2);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("rejects canvas_image with a PDF file", async () => {
    const project = await desks.createProject("it-canvas-pdf");
    try {
      const pdf = await seedFile(project.id, "application/pdf");
      await expect(
        service.createPlaced(project.id, "canvas_image", { payload: { file_id: pdf.id }, createdBy: "designer" }, { kind: "canvas_image", x: 0, y: 0, rot: 0 }),
      ).rejects.toThrow("画布图片仅支持 JPEG/PNG");
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("rejects canvas_image with a file owned by another project", async () => {
    const owner = await desks.createProject("it-owner");
    const intruder = await desks.createProject("it-intruder");
    try {
      const foreign = await seedFile(owner.id, "image/png");
      await expect(
        service.createPlaced(intruder.id, "canvas_image", { payload: { file_id: foreign.id }, createdBy: "designer" }, { kind: "canvas_image", x: 0, y: 0, rot: 0 }),
      ).rejects.toThrow("图片文件不属于当前项目");
    } finally {
      await desks.deleteProject(owner.id);
      await desks.deleteProject(intruder.id);
    }
  });

  itDb("accepts canvas_image with an owned PNG", async () => {
    const project = await desks.createProject("it-canvas-png");
    try {
      const png = await seedFile(project.id, "image/png");
      const result = await service.createPlaced(project.id, "canvas_image", { payload: { file_id: png.id }, createdBy: "designer" }, { kind: "canvas_image", x: 5, y: 6, rot: 0 });
      expect(result.object.artifact_id).toBe(result.artifact.id);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("deletePlaced removes layout and hard-deletes the artifact with its versions", async () => {
    const project = await desks.createProject("it-delete");
    try {
      const placed = await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, { kind: "canvas_image", x: 1, y: 1, rot: 0 });
      await service.append(placed.artifact.id, { payload: { pending: true, prompt: "v2" }, createdBy: "designer" });
      await service.deletePlaced(project.id, placed.artifact.id);
      const snapshot = await desks.snapshot(project.id);
      expect(snapshot.deskState.objects).toHaveLength(0);
      expect(snapshot.artifacts).toHaveLength(0);
      const rows = await db!.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, placed.artifact.id));
      expect(rows).toHaveLength(0);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  /** 回归：硬删物件不级联删 stored_files → 立刻成为无引用孤儿（会话 undo 依赖同 file_id）。 */
  itDb("deletePlaced leaves the canvas image file on disk (orphan until GC)", async () => {
    const project = await desks.createProject("it-delete-orphan-file");
    try {
      const png = await seedFile(project.id, "image/png");
      const placed = await service.createPlaced(
        project.id,
        "canvas_image",
        { payload: { file_id: png.id }, inputRefs: [{ file_id: png.id }], createdBy: "designer" },
        { kind: "canvas_image", x: 1, y: 1, rot: 0 },
      );
      await service.deletePlaced(project.id, placed.artifact.id);
      const [row] = await db!.select({ id: storedFiles.id }).from(storedFiles).where(eq(storedFiles.id, png.id));
      expect(row?.id).toBe(png.id);
      expect(await service.referencesFile(png.id)).toBe(false);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("deletePlaced notifies object-deleted listener for async GC wiring", async () => {
    const project = await desks.createProject("it-delete-listener");
    const seen: string[] = [];
    service.setObjectDeletedListener((projectId) => {
      seen.push(projectId);
    });
    try {
      const placed = await service.createPlaced(
        project.id,
        "canvas_image",
        { payload: {}, createdBy: "designer" },
        { kind: "canvas_image", x: 0, y: 0, rot: 0 },
      );
      await service.deletePlaced(project.id, placed.artifact.id);
      expect(seen).toEqual([project.id]);
    } finally {
      service.setObjectDeletedListener(() => undefined);
      await desks.deleteProject(project.id);
    }
  });

  itDb("deletePlaced rejects objects not on the desk", async () => {
    const project = await desks.createProject("it-delete-missing");
    try {
      await expect(service.deletePlaced(project.id, crypto.randomUUID())).rejects.toThrow("该物件不在桌面上");
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("restorePlaced recreates the artifact with the same UUID and restores layout", async () => {
    const project = await desks.createProject("it-restore");
    try {
      const placed = await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, { kind: "canvas_image", x: 7, y: 8, rot: 0 });
      await service.deletePlaced(project.id, placed.artifact.id);
      const restored = await service.restorePlaced(project.id, {
        artifactId: placed.artifact.id,
        artifactType: "canvas_image",
        payload: {},
        createdBy: "designer",
        layout: { kind: "canvas_image", x: 7, y: 8, rot: 0 },
      });
      expect(restored.artifact.id).toBe(placed.artifact.id);
      expect(restored.version.versionNo).toBe(1);
      const snapshot = await desks.snapshot(project.id);
      expect(snapshot.deskState.objects).toHaveLength(1);
      expect(snapshot.artifacts[0]?.artifactType).toBe("canvas_image");
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("restorePlaced refuses to overwrite an existing artifact", async () => {
    const project = await desks.createProject("it-restore-conflict");
    try {
      const placed = await service.createPlaced(project.id, "canvas_image", { payload: {}, createdBy: "designer" }, { kind: "canvas_image", x: 0, y: 0, rot: 0 });
      await expect(
        service.restorePlaced(project.id, {
          artifactId: placed.artifact.id,
          artifactType: "canvas_image",
          payload: {},
          createdBy: "designer",
          layout: { kind: "canvas_image", x: 0, y: 0, rot: 0 },
        }),
      ).rejects.toThrow("该 Artifact 已存在");
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
