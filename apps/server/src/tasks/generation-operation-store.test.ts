import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { generationOperations } from "../db/schema.js";
import { DeskStateService } from "../services/desk-state-service.js";
import { GenerationOperationStore } from "./generation-operation-store.js";
import { TaskStore } from "./task-store.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL
  ?? "postgresql://qijian:qijian@localhost:5433/qijian";
let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  db = created.db;
  pool = created.pool;
  await db.select({ id: generationOperations.id }).from(generationOperations).limit(1);
  available = true;
} catch {
  console.warn("[integration] generation operation database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

describe("GenerationOperationStore (integration)", () => {
  itDb("claims provider work once and finalizes its side effect once", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("generation-operation");
    const taskId = crypto.randomUUID();
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    try {
      await tasks.accept({
        payload: {
          schema_version: 1,
          kind: "image.generate",
          operation: "spawn",
          project_id: project.id,
          task_id: taskId,
          references: [],
          target_version: 0,
          prompt: "operation test",
          model: "fake-model",
          origin: { type: "panel", name: "test" },
        },
        taskKind: "operation-test",
      });

      const first = await operations.ensure({
        taskId,
        projectId: project.id,
        operationKey: taskId,
        expectedTargetVersion: 0,
      });
      const repeated = await operations.ensure({
        taskId,
        projectId: project.id,
        operationKey: taskId,
        expectedTargetVersion: 0,
      });
      expect(repeated.id).toBe(first.id);
      expect(await operations.beginProvider(taskId)).toMatchObject({ status: "provider_pending", attempt: 1 });
      expect(await operations.beginProvider(taskId)).toBeUndefined();
      await operations.recordDownloaded({ taskId, result: { fileId: "file-1" } });

      let sideEffects = 0;
      const finalized = await operations.finalize(taskId, async () => {
        sideEffects += 1;
        return { artifactId: "artifact-1", versionId: "version-1" };
      });
      const replayed = await operations.finalize(taskId, async () => {
        sideEffects += 1;
        return { artifactId: "wrong", versionId: "wrong" };
      });

      expect(finalized).toEqual({
        replayed: false,
        value: { artifactId: "artifact-1", versionId: "version-1" },
      });
      expect(replayed).toEqual({
        replayed: true,
        value: { artifactId: "artifact-1", versionId: "version-1" },
      });
      expect(sideEffects).toBe(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
