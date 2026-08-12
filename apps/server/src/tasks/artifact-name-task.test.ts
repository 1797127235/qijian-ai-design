import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import { ArtifactService } from "../services/artifact-service.js";
import { DeskStateService } from "../services/desk-state-service.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL
  ?? "postgresql://qijian:qijian@localhost:5433/qijian";
let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  db = created.db;
  pool = created.pool;
  await db.select({ id: artifacts.id }).from(artifacts).limit(1);
  available = true;
} catch {
  console.warn("[integration] artifact naming database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

describe("artifact model naming tokens", () => {
  itDb("rejects an older generation token and accepts the latest one", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("artifact-name-token");
    const service = new ArtifactService(db!);
    try {
      const created = await service.create(project.id, "effect_image", {
        payload: { pending: true, prompt: "living room" },
        createdBy: "designer",
      });
      const older = await service.prepareModelDisplayName(created.artifact.id);
      const latest = await service.prepareModelDisplayName(created.artifact.id);
      expect(older && latest).toBeTruthy();

      expect(await service.applyGeneratedDisplayName({
        artifactId: created.artifact.id,
        name: "迟到名称",
        nameVersion: older!.nameVersion,
        generationToken: older!.generationToken,
        displayNameSource: older!.displayNameSource,
      })).toBe(false);
      expect(await service.applyGeneratedDisplayName({
        artifactId: created.artifact.id,
        name: "客厅 · 暖木",
        nameVersion: latest!.nameVersion,
        generationToken: latest!.generationToken,
        displayNameSource: latest!.displayNameSource,
      })).toBe(true);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("never overwrites a user name with a queued model result", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("artifact-name-user");
    const service = new ArtifactService(db!);
    try {
      const created = await service.create(project.id, "effect_image", {
        payload: { pending: true, prompt: "bedroom" },
        createdBy: "designer",
      });
      const queued = await service.prepareModelDisplayName(created.artifact.id);
      await service.setDisplayName(created.artifact.id, "我的主卧", "user");

      expect(await service.applyGeneratedDisplayName({
        artifactId: created.artifact.id,
        name: "主卧 · 暖光",
        nameVersion: queued!.nameVersion,
        generationToken: queued!.generationToken,
        displayNameSource: queued!.displayNameSource,
      })).toBe(false);
      expect((await service.getDisplayName(created.artifact.id)).displayName).toBe("我的主卧");
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("user clear (source=user empty) still blocks later model apply", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("artifact-name-clear");
    const service = new ArtifactService(db!);
    try {
      const created = await service.create(project.id, "effect_image", {
        payload: { pending: true, prompt: "kitchen" },
        createdBy: "designer",
      });
      const queued = await service.prepareModelDisplayName(created.artifact.id);
      await service.setDisplayName(created.artifact.id, "临时", "user");
      await service.setDisplayName(created.artifact.id, null, "user");
      const afterClear = await service.getDisplayName(created.artifact.id);
      expect(afterClear.displayName).toBeNull();
      expect(afterClear.displayNameSource).toBe("user");

      expect(await service.applyGeneratedDisplayName({
        artifactId: created.artifact.id,
        name: "厨房",
        nameVersion: queued!.nameVersion,
        generationToken: queued!.generationToken,
        displayNameSource: queued!.displayNameSource,
      })).toBe(false);
      expect((await service.getDisplayName(created.artifact.id)).displayName).toBeNull();
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
