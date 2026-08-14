import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.js";
import { agentJobs, taskEvents, taskQueueOutbox } from "../db/schema.js";
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
  await created.db.select({ id: taskQueueOutbox.id }).from(taskQueueOutbox).limit(1);
  db = created.db;
  pool = created.pool;
  available = true;
} catch {
  console.warn("[integration] task database unavailable — skipping");
}

afterAll(async () => {
  if (pool) await pool.end();
});

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
    prompt: "生成客厅",
    model: "fake-model",
    origin: { type: "panel", name: "generate-image" },
  };
}

describe("TaskStore (integration)", () => {
  itDb("accepts a task and outbox in one transaction", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-accept");
    const store = new TaskStore(db!);
    try {
      const payload = imageTask(project.id);
      const traceContext = {
        traceId: "trace-root-1",
        parentRunId: "trace-tool-1",
        langsmithTrace: "20260812T000000000001Ztrace-root-1.20260812T000001000002Ztrace-tool-1",
      };
      const accepted = await store.accept({
        payload,
        taskKind: "generate_from_desk",
        traceContext,
      });
      expect(accepted.id).toBe(payload.task_id);
      expect(accepted.status).toBe("enqueue_pending");
      expect(accepted.traceContext).toEqual(traceContext);

      const [outbox] = await db!.select().from(taskQueueOutbox)
        .where(eq(taskQueueOutbox.taskId, payload.task_id));
      expect(outbox?.status).toBe("pending");
      expect(outbox?.payload).toEqual(payload);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("rolls back the task and outbox when prepare fails", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-rollback");
    const store = new TaskStore(db!);
    const payload = imageTask(project.id);
    try {
      await expect(store.accept({
        payload,
        taskKind: "generate_from_desk",
        prepare: async () => {
          throw new Error("prepare failed");
        },
      })).rejects.toThrow("prepare failed");

      const jobs = await db!.select().from(agentJobs).where(eq(agentJobs.id, payload.task_id));
      const outbox = await db!.select().from(taskQueueOutbox)
        .where(eq(taskQueueOutbox.taskId, payload.task_id));
      expect(jobs).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("claims, releases, and reclaims an outbox record", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-claim");
    const store = new TaskStore(db!);
    try {
      const payload = imageTask(project.id);
      await store.accept({ payload, taskKind: "generate_from_desk" });
      const [claimed] = await store.claimOutbox("worker-a", 1, project.id);
      expect(claimed?.taskId).toBe(payload.task_id);
      expect(await store.claimOutbox("worker-b", 1, project.id)).toHaveLength(0);

      await store.releaseOutbox(claimed.id, "redis down", 0);
      const [reclaimed] = await store.claimOutbox("worker-b", 1, project.id);
      expect(reclaimed?.id).toBe(claimed.id);
      expect(reclaimed?.attempts).toBe(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("finalizes a task only once", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-cas");
    const store = new TaskStore(db!);
    try {
      const payload = imageTask(project.id);
      await store.accept({ payload, taskKind: "generate_from_desk" });
      await store.markEnqueued(payload.task_id, payload.task_id);
      const first = await store.finalize(payload.task_id, "succeeded", { result: { ok: true } });
      const second = await store.finalize(payload.task_id, "failed", { error: "late" });
      expect(first?.status).toBe("succeeded");
      expect(second).toBeUndefined();

      const [row] = await db!.select().from(agentJobs).where(and(
        eq(agentJobs.projectId, project.id),
        eq(agentJobs.id, payload.task_id),
      ));
      expect(row.status).toBe("succeeded");
      expect(row.error).toBeNull();
      const terminalEvents = await db!.select().from(taskEvents).where(and(
        eq(taskEvents.taskId, payload.task_id),
        eq(taskEvents.type, "task.terminal"),
      ));
      expect(terminalEvents).toHaveLength(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("marks the same BullMQ job as enqueued idempotently", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-enqueue-idempotent");
    const store = new TaskStore(db!);
    try {
      const payload = imageTask(project.id);
      await store.accept({ payload, taskKind: "generate_from_desk" });

      const first = await store.markEnqueued(payload.task_id, payload.task_id);
      const repeated = await store.markEnqueued(payload.task_id, payload.task_id);

      expect(first?.status).toBe("accepted");
      expect(repeated).toEqual(first);
      const [outbox] = await db!.select().from(taskQueueOutbox)
        .where(eq(taskQueueOutbox.taskId, payload.task_id));
      expect(outbox?.status).toBe("enqueued");
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("reclaims a stale outbox claim after a dispatcher crash", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-reclaim");
    const store = new TaskStore(db!);
    try {
      const payload = imageTask(project.id);
      await store.accept({ payload, taskKind: "generate_from_desk" });
      const [claimed] = await store.claimOutbox("crashed-worker", 1, project.id);
      await db!.update(taskQueueOutbox)
        .set({ lockedAt: new Date(Date.now() - 60_000) })
        .where(eq(taskQueueOutbox.id, claimed.id));

      const reclaimed = await store.reclaimStaleOutbox(30_000);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].status).toBe("pending");
      expect(reclaimed[0].lockOwner).toBeNull();
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("rejects accept when unfinished tasks exceed the project quota", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("task-store-accept-quota");
    const store = new TaskStore(db!);
    try {
      await store.accept({ payload: imageTask(project.id), taskKind: "generate_from_desk", maxUnfinished: 1 });
      await expect(store.accept({
        payload: imageTask(project.id),
        taskKind: "generate_from_desk",
        maxUnfinished: 1,
      })).rejects.toThrow("未完成任务不能超过");
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
