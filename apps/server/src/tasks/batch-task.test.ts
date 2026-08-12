import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.js";
import { taskBatches } from "../db/schema.js";
import { DeskStateService } from "../services/desk-state-service.js";
import { TaskStore } from "./task-store.js";
import type { ImageGenerateTaskV1 } from "./types.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL
  ?? "postgresql://qijian:qijian@localhost:5433/qijian";
let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  db = created.db;
  pool = created.pool;
  await db.select({ id: taskBatches.id }).from(taskBatches).limit(1);
  available = true;
} catch {
  console.warn("[integration] batch database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

function imageTask(projectId: string): ImageGenerateTaskV1 {
  return {
    schema_version: 1, kind: "image.generate", operation: "spawn", project_id: projectId,
    task_id: crypto.randomUUID(), references: [], target_version: 1, prompt: "batch", model: "fake",
    origin: { type: "batch", name: "batch-test" },
  };
}

describe("TaskStore batch acceptance", () => {
  itDb("creates one batch and deduplicates terminal progress", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("batch-store");
    const store = new TaskStore(db!);
    try {
      const tasks = [imageTask(project.id), imageTask(project.id), imageTask(project.id)];
      const accepted = await store.acceptBatch({
        projectId: project.id,
        createdBy: "designer",
        tasks: tasks.map((payload) => ({ payload, taskKind: "batch-test" })),
      });
      expect(accepted.batch.total).toBe(3);
      expect(accepted.tasks).toHaveLength(3);
      for (const task of tasks) await store.markEnqueued(task.task_id, task.task_id);

      await store.finalize(tasks[0].task_id, "succeeded");
      await store.finalize(tasks[0].task_id, "failed");
      await store.finalize(tasks[1].task_id, "failed");
      await store.finalize(tasks[2].task_id, "succeeded");
      const [batch] = await db!.select().from(taskBatches).where(eq(taskBatches.id, accepted.batch.id));
      expect(batch).toMatchObject({ status: "partial_failed", completed: 3, succeeded: 2, failed: 1 });
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("marks cancelled_with_side_effect when success mixes with cancel", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("batch-cancel-mix");
    const store = new TaskStore(db!);
    try {
      const tasks = [imageTask(project.id), imageTask(project.id)];
      const accepted = await store.acceptBatch({
        projectId: project.id,
        createdBy: "designer",
        tasks: tasks.map((payload) => ({ payload, taskKind: "batch-test" })),
      });
      for (const task of tasks) await store.markEnqueued(task.task_id, task.task_id);
      await store.finalize(tasks[0].task_id, "succeeded");
      // 最后一条是 cancelled：旧逻辑会误标 succeeded；deriveBatchStatus 应为 cancelled_with_side_effect
      await store.finalize(tasks[1].task_id, "cancelled");
      const [batch] = await db!.select().from(taskBatches).where(eq(taskBatches.id, accepted.batch.id));
      expect(batch).toMatchObject({
        status: "cancelled_with_side_effect",
        completed: 2,
        succeeded: 1,
        cancelled: 1,
      });
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  it("rejects batches larger than twenty before touching the database", async () => {
    const store = new TaskStore({} as never);
    const projectId = crypto.randomUUID();
    const tasks = Array.from({ length: 21 }, () => imageTask(projectId));
    await expect(store.acceptBatch({
      projectId,
      createdBy: "designer",
      tasks: tasks.map((payload) => ({ payload, taskKind: "batch-test" })),
    })).rejects.toThrow("1-20");
  });
});
