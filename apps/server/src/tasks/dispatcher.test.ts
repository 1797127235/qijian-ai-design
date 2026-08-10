import { describe, expect, it, vi } from "vitest";
import { TaskOutboxDispatcher, type DispatcherStore } from "./dispatcher.js";
import type { OutboxRow } from "./task-store.js";
import type { ImageGenerateTaskV1, TaskPayload } from "./types.js";

function imageTask(): ImageGenerateTaskV1 {
  return {
    schema_version: 1,
    kind: "image.generate",
    operation: "spawn",
    project_id: crypto.randomUUID(),
    task_id: crypto.randomUUID(),
    references: [],
    target_version: 0,
    prompt: "dispatcher test",
    model: "fake-model",
    origin: { type: "panel", name: "test" },
  };
}

function outbox(payload: TaskPayload, attempts = 0): OutboxRow {
  return {
    id: crypto.randomUUID(),
    taskId: payload.task_id,
    projectId: payload.project_id,
    status: "pending",
    payload,
    attempts,
    availableAt: new Date(),
    lockedAt: null,
    lockOwner: null,
    error: null,
    createdAt: new Date(),
    enqueuedAt: null,
  };
}

function mockStore(row: OutboxRow, hooks: {
  release?: (error: string, delayMs: number) => void;
  fail?: (error: string) => void;
  finalize?: (status: string, error?: string) => void;
  getArtifactId?: string;
} = {}): DispatcherStore {
  return {
    claimOutbox: async () => {
      if (row.status !== "pending") return [];
      row.status = "claimed";
      return [row];
    },
    releaseOutbox: async (_id, error, delayMs) => {
      row.status = "pending";
      row.error = error;
      row.attempts += 1;
      hooks.release?.(error, delayMs);
      return row;
    },
    failOutbox: async (_id, error) => {
      row.status = "failed";
      row.error = error;
      hooks.fail?.(error);
      return row;
    },
    markEnqueued: async () => {
      row.status = "enqueued";
      return { id: row.taskId };
    },
    markOutboxEnqueued: async () => undefined,
    finalize: async (_taskId, status, patch) => {
      hooks.finalize?.(status, patch?.error);
      return { artifactId: hooks.getArtifactId ?? null };
    },
    get: async () => ({ artifactId: hooks.getArtifactId ?? null }),
  };
}

describe("TaskOutboxDispatcher", () => {
  it("releases on Redis failure and retries after recovery", async () => {
    const row = outbox(imageTask());
    let fail = true;
    const store = mockStore(row);
    const queue = {
      enqueue: async (task: TaskPayload) => {
        if (fail) throw new Error("redis unavailable");
        return { id: task.task_id };
      },
    };
    const dispatcher = new TaskOutboxDispatcher(store, queue, {
      owner: "dispatcher-test",
      retryBaseMs: 0,
      maxAttempts: 20,
    });

    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      enqueued: 0,
      released: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(row).toMatchObject({ status: "pending", attempts: 1, error: "redis unavailable" });

    fail = false;
    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      enqueued: 1,
      released: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(row.status).toBe("enqueued");
  });

  it("dead-letters after max enqueue attempts and finalizes the task", async () => {
    const payload = imageTask();
    const row = outbox(payload, 2); // next failure is attempt 3 → exhaust at max 3
    let finalized: { status: string; error?: string } | undefined;
    const deadLetter = vi.fn(async () => undefined);
    const store = mockStore(row, {
      finalize: (status, error) => {
        finalized = { status, error };
      },
      getArtifactId: "art-pending",
    });
    const dispatcher = new TaskOutboxDispatcher(
      store,
      { enqueue: async () => { throw new Error("redis down"); } },
      {
        owner: "dispatcher-dead",
        maxAttempts: 3,
        retryBaseMs: 100,
        onDeadLetter: deadLetter,
      },
    );

    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      enqueued: 0,
      released: 0,
      failed: 0,
      deadLettered: 1,
    });
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/outbox enqueue exhausted after 3 attempts/);
    expect(finalized).toMatchObject({ status: "failed" });
    expect(finalized?.error).toMatch(/exhausted after 3/);
    expect(deadLetter).toHaveBeenCalledWith(expect.objectContaining({
      taskId: payload.task_id,
      artifactId: "art-pending",
      payload,
    }));
  });

  it("uses exponential backoff on release, not flat delay", async () => {
    const row = outbox(imageTask(), 2);
    let delayMs = -1;
    const store = mockStore(row, {
      release: (_error, delay) => {
        delayMs = delay;
      },
    });
    const dispatcher = new TaskOutboxDispatcher(
      store,
      { enqueue: async () => { throw new Error("transient"); } },
      { owner: "backoff", maxAttempts: 20, retryBaseMs: 1_000 },
    );
    await dispatcher.dispatchOnce();
    // attemptIndex = row.attempts (2) before increment → 1000 * 2^2 = 4000
    expect(delayMs).toBe(4_000);
    expect(row.attempts).toBe(3);
    expect(row.status).toBe("pending");
  });

  it("fails invalid payload immediately and finalizes the task", async () => {
    const row = outbox(imageTask());
    row.payload = { broken: true } as never;
    let finalized: string | undefined;
    const store = mockStore(row, {
      finalize: (status) => {
        finalized = status;
      },
    });
    const dispatcher = new TaskOutboxDispatcher(
      store,
      { enqueue: async () => ({ id: "x" }) },
      { owner: "bad-payload" },
    );
    expect(await dispatcher.dispatchOnce()).toMatchObject({
      claimed: 1,
      failed: 1,
      deadLettered: 0,
      enqueued: 0,
    });
    expect(row.status).toBe("failed");
    expect(finalized).toBe("failed");
  });
});
