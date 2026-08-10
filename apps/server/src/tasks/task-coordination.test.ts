import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { agentJobs } from "../db/schema.js";
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
  await db.select({ id: agentJobs.id }).from(agentJobs).limit(1);
  available = true;
} catch {
  console.warn("[integration] task coordination database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

function imageTask(projectId: string): ImageGenerateTaskV1 {
  return {
    schema_version: 1,
    kind: "image.generate",
    operation: "spawn",
    project_id: projectId,
    task_id: crypto.randomUUID(),
    references: [],
    target_version: 0,
    prompt: "coordination test",
    model: "fake-model",
    origin: { type: "panel", name: "test" },
  };
}

describe("TaskStore distributed coordination", () => {
  itDb("starts at most two image tasks for one project", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-quota");
    const store = new TaskStore(db!);
    try {
      const tasks = [imageTask(project.id), imageTask(project.id), imageTask(project.id)];
      for (const task of tasks) {
        await store.accept({ payload: task, taskKind: "quota-test" });
        await store.markEnqueued(task.task_id, task.task_id);
      }
      expect((await store.tryMarkRunning(tasks[0].task_id, 2)).started).toBe(true);
      expect((await store.tryMarkRunning(tasks[1].task_id, 2)).started).toBe(true);
      expect((await store.tryMarkRunning(tasks[2].task_id, 2)).started).toBe(false);
      // 已 running 的 task 再领应 resumed，不得当配额满
      expect(await store.tryMarkRunning(tasks[0].task_id, 2)).toMatchObject({
        started: true,
        resumed: true,
      });

      await store.finalize(tasks[0].task_id, "succeeded");
      expect((await store.tryMarkRunning(tasks[2].task_id, 2)).started).toBe(true);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("cancels waiting tasks and persists intent for running tasks", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-cancel");
    const store = new TaskStore(db!);
    try {
      const waiting = imageTask(project.id);
      const running = imageTask(project.id);
      for (const task of [waiting, running]) {
        await store.accept({ payload: task, taskKind: "cancel-test" });
        await store.markEnqueued(task.task_id, task.task_id);
      }
      await store.tryMarkRunning(running.task_id, 2);

      expect((await store.requestCancel(waiting.task_id))?.status).toBe("cancelled");
      expect((await store.requestCancel(running.task_id))?.status).toBe("running");
      expect(await store.isCancellationRequested(running.task_id)).toBe(true);
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
