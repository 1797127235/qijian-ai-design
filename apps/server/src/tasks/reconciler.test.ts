import { describe, expect, it } from "vitest";
import { TaskQueueReconciler, type QueueJobState, type ReconcilerStore } from "./reconciler.js";
import type { OutboxRow } from "./task-store.js";

function outbox(taskId: string): OutboxRow {
  return {
    id: crypto.randomUUID(),
    taskId,
    projectId: crypto.randomUUID(),
    status: "enqueued",
    payload: {},
    attempts: 0,
    availableAt: new Date(),
    lockedAt: null,
    lockOwner: null,
    error: null,
    createdAt: new Date(),
    enqueuedAt: new Date(),
  };
}

function storeFor(
  taskId: string,
  row: OutboxRow,
  status: string,
  hooks: {
    requeue?: () => Promise<OutboxRow | undefined>;
    finalize?: (status: string) => Promise<unknown>;
  } = {},
): ReconcilerStore {
  return {
    reclaimStaleOutbox: async () => [],
    listOutbox: async () => [row],
    get: async () => ({ id: taskId, queueJobId: taskId, status }),
    requeueEnqueuedOutbox: async () => hooks.requeue?.() ?? undefined,
    finalize: async (_taskId, terminal) => hooks.finalize?.(terminal) ?? undefined,
  };
}

describe("TaskQueueReconciler", () => {
  it("requeues accepted tasks whose Redis Job disappeared", async () => {
    const taskId = crypto.randomUUID();
    const row = outbox(taskId);
    const reconciler = new TaskQueueReconciler(
      storeFor(taskId, row, "accepted", {
        requeue: async () => {
          row.status = "pending";
          return row;
        },
      }),
      { getJobState: async () => "missing" },
    );

    expect(await reconciler.reconcileOnce()).toMatchObject({ requeued: 1, needsReview: 0 });
    expect(row.status).toBe("pending");
  });

  it("moves a running task to needs_review when its Redis Job disappeared", async () => {
    const taskId = crypto.randomUUID();
    const row = outbox(taskId);
    let finalized: string | undefined;
    const reconciler = new TaskQueueReconciler(
      storeFor(taskId, row, "running", {
        finalize: async (status) => {
          finalized = status;
          return { id: taskId };
        },
      }),
      { getJobState: async () => "missing" },
    );

    expect(await reconciler.reconcileOnce()).toMatchObject({ needsReview: 1, requeued: 0 });
    expect(finalized).toBe("needs_review");
  });

  it("unsticks running tasks when Redis job already failed or completed", async () => {
    for (const state of ["failed", "completed"] as QueueJobState[]) {
      const taskId = crypto.randomUUID();
      const row = outbox(taskId);
      let finalized: string | undefined;
      const reconciler = new TaskQueueReconciler(
        storeFor(taskId, row, "running", {
          finalize: async (status) => {
            finalized = status;
            return { id: taskId };
          },
        }),
        { getJobState: async () => state },
      );
      expect(await reconciler.reconcileOnce()).toMatchObject({ needsReview: 1, requeued: 0 });
      expect(finalized).toBe("needs_review");
    }
  });

  it("does not requeue accepted tasks whose Redis job already failed", async () => {
    const taskId = crypto.randomUUID();
    const row = outbox(taskId);
    let requeued = false;
    let finalized: string | undefined;
    const reconciler = new TaskQueueReconciler(
      storeFor(taskId, row, "accepted", {
        requeue: async () => {
          requeued = true;
          return row;
        },
        finalize: async (status) => {
          finalized = status;
          return { id: taskId };
        },
      }),
      { getJobState: async () => "failed" },
    );
    expect(await reconciler.reconcileOnce()).toMatchObject({ needsReview: 1, requeued: 0 });
    expect(requeued).toBe(false);
    expect(finalized).toBe("needs_review");
  });

  it("leaves active Redis jobs alone", async () => {
    const taskId = crypto.randomUUID();
    const row = outbox(taskId);
    let finalized = false;
    const reconciler = new TaskQueueReconciler(
      storeFor(taskId, row, "running", {
        finalize: async () => {
          finalized = true;
          return { id: taskId };
        },
      }),
      { getJobState: async () => "active" },
    );
    expect(await reconciler.reconcileOnce()).toMatchObject({ needsReview: 0, requeued: 0 });
    expect(finalized).toBe(false);
  });
});
