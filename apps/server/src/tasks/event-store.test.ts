import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { taskEvents } from "../db/schema.js";
import { DeskStateService } from "../services/desk-state-service.js";
import { TaskEventStore } from "./event-store.js";
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
  await db.select({ id: taskEvents.id }).from(taskEvents).limit(1);
  available = true;
} catch {
  console.warn("[integration] task event database unavailable - skipping");
}

afterAll(async () => {
  if (pool) await pool.end();
});

const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

describe("TaskEventStore (integration)", () => {
  itDb("deduplicates the same event key and reads events in sequence", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-event-store");
    const store = new TaskEventStore(db!);
    const tasks = new TaskStore(db!);
    const taskId = crypto.randomUUID();
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
          prompt: "event test",
          model: "fake-model",
          origin: { type: "panel", name: "test" },
        },
        taskKind: "event-test",
      });
      const first = await store.append({
        taskId,
        projectId: project.id,
        eventKey: `${taskId}:progress`,
        type: "task.progress",
        payload: { status: "running" },
      });
      const duplicate = await store.append({
        taskId,
        projectId: project.id,
        eventKey: `${taskId}:progress`,
        type: "task.progress",
      });
      expect(first?.eventKey).toContain(":progress");
      expect(duplicate).toBeUndefined();
      const events = await store.listAfter(project.id);
      expect(events.filter((event) => event.eventKey === `${taskId}:progress`)).toHaveLength(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
