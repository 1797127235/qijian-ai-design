import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { DeskStateService } from "../services/desk-state-service.js";
import { TaskCancellationService } from "./cancellation.js";
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
  available = true;
} catch {
  console.warn("[integration] cancellation database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

function imageTask(projectId: string): ImageGenerateTaskV1 {
  return {
    schema_version: 1, kind: "image.generate", operation: "spawn", project_id: projectId,
    task_id: crypto.randomUUID(), references: [], target_version: 0, prompt: "cancel", model: "fake",
    origin: { type: "panel", name: "cancel-test" },
  };
}

describe("TaskCancellationService", () => {
  itDb("persists cancellation before removing only waiting jobs", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-cancellation");
    const store = new TaskStore(db!);
    const removed: string[] = [];
    const service = new TaskCancellationService(store, { cancelJob: async (id) => { removed.push(id); return true; } });
    try {
      const waiting = imageTask(project.id);
      const running = imageTask(project.id);
      for (const task of [waiting, running]) {
        await store.accept({ payload: task, taskKind: "cancel-test" });
        await store.markEnqueued(task.task_id, task.task_id);
      }
      await store.tryMarkRunning(running.task_id, 2);

      await service.cancelJob(waiting.task_id);
      await service.cancelJob(running.task_id);

      expect(removed).toEqual([waiting.task_id]);
      expect(await store.isCancellationRequested(running.task_id)).toBe(true);
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
