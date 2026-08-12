import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentJobs, projects, taskBatches, taskEvents, taskQueueOutbox } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { deriveBatchStatus } from "./state-machine.js";
import type { TerminalTaskStatus } from "./task-queue.js";
import { taskPayloadSchema, type TaskPayload } from "./types.js";

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type TaskRow = typeof agentJobs.$inferSelect;
type BatchRow = typeof taskBatches.$inferSelect;
export type OutboxRow = typeof taskQueueOutbox.$inferSelect;
type OutboxStatus = OutboxRow["status"];

const ACTIVE_TASK_STATUSES = ["enqueue_pending", "accepted", "running"] as const;

export class TaskStore {
  constructor(private readonly db: Database) {}

  async accept(input: {
    payload: TaskPayload;
    taskKind: string;
    batchId?: string;
    threadId?: string;
    runId?: string;
    traceRootId?: string;
    traceParentId?: string;
    /** 项目未完成任务上限（含本任务）；默认 100，与 acceptBatch 一致 */
    maxUnfinished?: number;
    prepare?: (
      tx: DatabaseTransaction,
      taskId: string,
    ) => Promise<{ artifactId?: string } | void>;
  }): Promise<TaskRow> {
    const payload = taskPayloadSchema.parse(input.payload);
    const maxUnfinished = input.maxUnfinished ?? 100;
    return this.db.transaction(async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, payload.project_id)).for("update");
      if (!project) throw new HttpError(404, "未找到该设计项目");
      const unfinished = await tx.select({ id: agentJobs.id }).from(agentJobs).where(and(
        eq(agentJobs.projectId, payload.project_id),
        inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
      ));
      if (unfinished.length + 1 > maxUnfinished) {
        throw new HttpError(422, `项目未完成任务不能超过 ${maxUnfinished} 个`);
      }

      const [task] = await tx.insert(agentJobs).values({
        id: payload.task_id,
        projectId: payload.project_id,
        batchId: input.batchId,
        threadId: input.threadId,
        runId: input.runId,
        traceRootId: input.traceRootId,
        traceParentId: input.traceParentId,
        kind: input.taskKind,
        status: "enqueue_pending",
        taskRole: payload.kind === "artifact.name" ? "name" : "image",
        queueBackend: "bullmq",
        queueJobId: payload.task_id,
        payloadVersion: payload.schema_version,
        input: payload,
      }).returning();

      await tx.insert(taskQueueOutbox).values({
        taskId: task.id,
        projectId: task.projectId,
        payload,
      });

      await tx.insert(taskEvents).values({
        taskId: task.id,
        projectId: task.projectId,
        eventKey: `${task.id}:accepted`,
        type: "task.accepted",
        payload: { status: "enqueue_pending", kind: payload.kind },
      });

      const prepared = await input.prepare?.(tx, task.id);
      if (!prepared?.artifactId) return task;
      const [withArtifact] = await tx.update(agentJobs)
        .set({ artifactId: prepared.artifactId })
        .where(eq(agentJobs.id, task.id))
        .returning();
      return withArtifact;
    });
  }

  async acceptBatch(input: {
    projectId: string;
    createdBy: string;
    input?: unknown;
    tasks: Array<{
      payload: TaskPayload;
      taskKind: string;
      prepare?: (
        tx: DatabaseTransaction,
        taskId: string,
      ) => Promise<{ artifactId?: string } | void>;
    }>;
    maxBatchSize?: number;
    maxUnfinished?: number;
  }): Promise<{ batch: BatchRow; tasks: TaskRow[] }> {
    const maxBatchSize = input.maxBatchSize ?? 20;
    const maxUnfinished = input.maxUnfinished ?? 100;
    if (input.tasks.length < 1 || input.tasks.length > maxBatchSize) {
      throw new HttpError(422, `批次任务数必须在 1-${maxBatchSize} 之间`);
    }
    const parsed = input.tasks.map((task) => ({ ...task, payload: taskPayloadSchema.parse(task.payload) }));
    if (parsed.some((task) => task.payload.project_id !== input.projectId)) {
      throw new HttpError(422, "批次任务必须属于同一项目");
    }
    return this.db.transaction(async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, input.projectId)).for("update");
      if (!project) throw new HttpError(404, "未找到该设计项目");
      const unfinished = await tx.select({ id: agentJobs.id }).from(agentJobs).where(and(
        eq(agentJobs.projectId, input.projectId),
        inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
      ));
      if (unfinished.length + parsed.length > maxUnfinished) {
        throw new HttpError(422, `项目未完成任务不能超过 ${maxUnfinished} 个`);
      }
      const [batch] = await tx.insert(taskBatches).values({
        projectId: input.projectId,
        total: parsed.length,
        input: input.input ?? {},
        createdBy: input.createdBy,
      }).returning();
      const accepted: TaskRow[] = [];
      for (const item of parsed) {
        const payload = item.payload;
        const prepared = await item.prepare?.(tx, payload.task_id);
        const [task] = await tx.insert(agentJobs).values({
          id: payload.task_id,
          projectId: payload.project_id,
          batchId: batch.id,
          kind: item.taskKind,
          status: "enqueue_pending",
          taskRole: payload.kind === "artifact.name" ? "name" : "image",
          queueBackend: "bullmq",
          queueJobId: payload.task_id,
          payloadVersion: payload.schema_version,
          input: payload,
          artifactId: prepared?.artifactId,
        }).returning();
        await tx.insert(taskQueueOutbox).values({
          taskId: task.id,
          projectId: task.projectId,
          payload,
        });
        await tx.insert(taskEvents).values({
          taskId: task.id,
          projectId: task.projectId,
          eventKey: `${task.id}:accepted`,
          type: "task.accepted",
          payload: { status: "enqueue_pending", kind: payload.kind, batch_id: batch.id },
        });
        accepted.push(task);
      }
      return { batch, tasks: accepted };
    });
  }

  async claimOutbox(owner: string, limit: number, projectId?: string): Promise<OutboxRow[]> {
    if (!owner.trim()) throw new Error("outbox owner is required");
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.db.transaction(async (tx) => {
      const conditions = [
          eq(taskQueueOutbox.status, "pending"),
          lte(taskQueueOutbox.availableAt, new Date()),
          ...(projectId ? [eq(taskQueueOutbox.projectId, projectId)] : []),
        ];
      const rows = await tx.select().from(taskQueueOutbox)
        .where(and(...conditions))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      return tx.update(taskQueueOutbox)
        .set({ status: "claimed", lockedAt: new Date(), lockOwner: owner, error: null })
        .where(inArray(taskQueueOutbox.id, ids))
        .returning();
    });
  }

  async releaseOutbox(id: string, error: string, delayMs: number): Promise<OutboxRow | undefined> {
    const [row] = await this.db.update(taskQueueOutbox)
      .set({
        status: "pending",
        attempts: sql`${taskQueueOutbox.attempts} + 1`,
        availableAt: new Date(Date.now() + Math.max(0, delayMs)),
        lockedAt: null,
        lockOwner: null,
        error: error.slice(0, 2_000),
      })
      .where(and(eq(taskQueueOutbox.id, id), eq(taskQueueOutbox.status, "claimed")))
      .returning();
    return row;
  }

  async failOutbox(id: string, error: string): Promise<OutboxRow | undefined> {
    const [row] = await this.db.update(taskQueueOutbox)
      .set({
        status: "failed",
        lockedAt: null,
        lockOwner: null,
        error: error.slice(0, 2_000),
      })
      .where(and(eq(taskQueueOutbox.id, id), eq(taskQueueOutbox.status, "claimed")))
      .returning();
    return row;
  }

  async markOutboxEnqueued(id: string): Promise<OutboxRow | undefined> {
    const [row] = await this.db.update(taskQueueOutbox)
      .set({ status: "enqueued", enqueuedAt: new Date(), lockedAt: null, lockOwner: null })
      .where(and(eq(taskQueueOutbox.id, id), eq(taskQueueOutbox.status, "claimed")))
      .returning();
    return row;
  }

  async requeueEnqueuedOutbox(id: string, error: string): Promise<OutboxRow | undefined> {
    const [row] = await this.db.update(taskQueueOutbox)
      .set({
        status: "pending",
        availableAt: new Date(),
        lockedAt: null,
        lockOwner: null,
        error: error.slice(0, 2_000),
      })
      .where(and(eq(taskQueueOutbox.id, id), eq(taskQueueOutbox.status, "enqueued")))
      .returning();
    return row;
  }

  async reclaimStaleOutbox(staleMs: number, limit = 100): Promise<OutboxRow[]> {
    const cutoff = new Date(Date.now() - Math.max(0, staleMs));
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.db.transaction(async (tx) => {
      const rows = await tx.select({ id: taskQueueOutbox.id }).from(taskQueueOutbox)
        .where(and(
          eq(taskQueueOutbox.status, "claimed"),
          lte(taskQueueOutbox.lockedAt, cutoff),
        ))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      return tx.update(taskQueueOutbox)
        .set({ status: "pending", lockedAt: null, lockOwner: null })
        .where(inArray(taskQueueOutbox.id, rows.map((row) => row.id)))
        .returning();
    });
  }

  async listOutbox(status: OutboxStatus, limit = 100): Promise<OutboxRow[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.db.select().from(taskQueueOutbox)
      .where(eq(taskQueueOutbox.status, status))
      .limit(boundedLimit);
  }

  async markEnqueued(taskId: string, queueJobId: string): Promise<TaskRow | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx.update(agentJobs)
        .set({ status: "accepted", queueJobId, enqueuedAt: now })
        .where(and(eq(agentJobs.id, taskId), eq(agentJobs.status, "enqueue_pending")))
        .returning();
      const [task] = updated
        ? [updated]
        : await tx.select().from(agentJobs).where(and(
          eq(agentJobs.id, taskId),
          eq(agentJobs.status, "accepted"),
          eq(agentJobs.queueJobId, queueJobId),
        ));
      if (!task) return undefined;
      await tx.insert(taskEvents).values({
        taskId: task.id,
        projectId: task.projectId,
        eventKey: `${task.id}:enqueued`,
        type: "task.enqueued",
        payload: { queue_job_id: queueJobId },
      }).onConflictDoNothing({ target: taskEvents.eventKey });
      await tx.update(taskQueueOutbox)
        .set({ status: "enqueued", enqueuedAt: now, lockedAt: null, lockOwner: null, error: null })
        .where(eq(taskQueueOutbox.taskId, taskId));
      return task;
    });
  }

  async markRunning(taskId: string): Promise<TaskRow | undefined> {
    const [task] = await this.db.update(agentJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(agentJobs.id, taskId), eq(agentJobs.status, "accepted")))
      .returning();
    return task;
  }

  async tryMarkRunning(taskId: string, maxActiveImages: number): Promise<{
    started: boolean;
    task?: TaskRow;
    /** true：本 task 已在 running（重投递/worker 重启），应继续执行而非 delayed */
    resumed?: boolean;
  }> {
    const boundedMax = Math.max(1, Math.floor(maxActiveImages));
    return this.db.transaction(async (tx) => {
      const [task] = await tx.select().from(agentJobs).where(eq(agentJobs.id, taskId)).for("update");
      if (!task) return { started: false };
      // 已在执行：允许 worker 续跑（杀进程后 redelivery 常见）；禁止当成配额满去 delayed
      if (task.status === "running") return { started: true, task, resumed: true };
      if (task.status !== "accepted") return { started: false };
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, task.projectId)).for("update");
      if (task.taskRole === "image") {
        const active = await tx.select({ id: agentJobs.id }).from(agentJobs).where(and(
          eq(agentJobs.projectId, task.projectId),
          eq(agentJobs.taskRole, "image"),
          eq(agentJobs.status, "running"),
        ));
        if (active.length >= boundedMax) return { started: false };
      }
      const [started] = await tx.update(agentJobs)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(agentJobs.id, taskId), eq(agentJobs.status, "accepted")))
        .returning();
      if (!started) return { started: false };
      await tx.insert(taskEvents).values({
        taskId: started.id,
        projectId: started.projectId,
        eventKey: `${started.id}:running`,
        type: "task.running",
        payload: { status: "running" },
      }).onConflictDoNothing({ target: taskEvents.eventKey });
      if (started.batchId) {
        await tx.update(taskBatches).set({ status: "running", updatedAt: new Date() })
          .where(and(eq(taskBatches.id, started.batchId), eq(taskBatches.status, "accepted")));
      }
      return { started: true, task: started };
    });
  }

  async requestCancel(taskId: string): Promise<TaskRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx.select().from(agentJobs).where(eq(agentJobs.id, taskId)).for("update");
      if (!task || !ACTIVE_TASK_STATUSES.includes(task.status as typeof ACTIVE_TASK_STATUSES[number])) return task;
      const now = new Date();
      if (task.status === "enqueue_pending" || task.status === "accepted") {
        const [cancelled] = await tx.update(agentJobs).set({
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          error: "cancel requested",
        }).where(and(eq(agentJobs.id, taskId), inArray(agentJobs.status, ["enqueue_pending", "accepted"]))).returning();
        if (cancelled) {
          await tx.insert(taskEvents).values({
            taskId: cancelled.id,
            projectId: cancelled.projectId,
            eventKey: `${cancelled.id}:terminal:cancelled`,
            type: "task.terminal",
            payload: { status: "cancelled", reason: "cancel_requested" },
          }).onConflictDoNothing({ target: taskEvents.eventKey });
        }
        return cancelled;
      }
      const [running] = await tx.update(agentJobs).set({ cancelRequestedAt: now })
        .where(and(eq(agentJobs.id, taskId), eq(agentJobs.status, "running"))).returning();
      return running;
    });
  }

  async requestCancelProject(projectId: string): Promise<TaskRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
      const active = await tx.select().from(agentJobs).where(and(
        eq(agentJobs.projectId, projectId),
        inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
      )).for("update");
      const cancelled: TaskRow[] = [];
      for (const task of active) {
        const now = new Date();
        if (task.status === "enqueue_pending" || task.status === "accepted") {
          const [row] = await tx.update(agentJobs).set({
            status: "cancelled",
            cancelRequestedAt: now,
            finishedAt: now,
            error: "cancel requested",
          }).where(and(
            eq(agentJobs.id, task.id),
            inArray(agentJobs.status, ["enqueue_pending", "accepted"]),
          )).returning();
          if (row) {
            cancelled.push(row);
            await tx.insert(taskEvents).values({
              taskId: row.id,
              projectId: row.projectId,
              eventKey: `${row.id}:terminal:cancelled`,
              type: "task.terminal",
              payload: { status: "cancelled", reason: "project_cancel_requested" },
            }).onConflictDoNothing({ target: taskEvents.eventKey });
          }
        } else {
          const [row] = await tx.update(agentJobs).set({ cancelRequestedAt: now })
            .where(and(eq(agentJobs.id, task.id), eq(agentJobs.status, "running"))).returning();
          if (row) cancelled.push(row);
        }
      }
      return cancelled;
    });
  }

  async listActiveByThread(projectId: string, threadId: string): Promise<TaskRow[]> {
    return this.db.select().from(agentJobs).where(and(
      eq(agentJobs.projectId, projectId),
      eq(agentJobs.threadId, threadId),
      inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
    ));
  }

  async listActiveByArtifact(projectId: string, artifactId: string): Promise<TaskRow[]> {
    return this.db.select().from(agentJobs).where(and(
      eq(agentJobs.projectId, projectId),
      eq(agentJobs.artifactId, artifactId),
      inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
    ));
  }

  async requestCancelThread(projectId: string, threadId: string): Promise<TaskRow[]> {
    const active = await this.listActiveByThread(projectId, threadId);
    const cancelled: TaskRow[] = [];
    for (const task of active) {
      const row = await this.requestCancel(task.id);
      if (row) cancelled.push(row);
    }
    return cancelled;
  }

  async requestCancelArtifact(projectId: string, artifactId: string): Promise<TaskRow[]> {
    const active = await this.listActiveByArtifact(projectId, artifactId);
    const cancelled: TaskRow[] = [];
    for (const task of active) {
      const row = await this.requestCancel(task.id);
      if (row) cancelled.push(row);
    }
    return cancelled;
  }

  async isCancellationRequested(taskId: string): Promise<boolean> {
    const [row] = await this.db.select({ requested: agentJobs.cancelRequestedAt })
      .from(agentJobs).where(eq(agentJobs.id, taskId));
    return Boolean(row?.requested);
  }

  async finalize(
    taskId: string,
    status: TerminalTaskStatus,
    patch: { result?: unknown; error?: string; artifactId?: string } = {},
  ): Promise<TaskRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(agentJobs)
        .set({
          status,
          result: patch.result,
          error: patch.error?.slice(0, 2_000),
          artifactId: patch.artifactId,
          finishedAt: new Date(),
        })
        .where(and(
          eq(agentJobs.id, taskId),
          inArray(agentJobs.status, [...ACTIVE_TASK_STATUSES]),
        ))
        .returning();
      if (!row) return undefined;
      await tx.insert(taskEvents).values({
        taskId: row.id,
        projectId: row.projectId,
        eventKey: `${row.id}:terminal:${status}`,
        type: "task.terminal",
        payload: { status, error: patch.error?.slice(0, 2_000) },
      }).onConflictDoNothing({ target: taskEvents.eventKey });
      if (row.batchId && row.taskRole === "image") {
        await this.applyBatchTerminal(tx, row.batchId, status);
      }
      return row;
    });
  }

  async get(taskId: string): Promise<TaskRow | undefined> {
    const [row] = await this.db.select().from(agentJobs).where(eq(agentJobs.id, taskId));
    return row;
  }

  async getOutbox(id: string): Promise<OutboxRow | undefined> {
    const [row] = await this.db.select().from(taskQueueOutbox).where(eq(taskQueueOutbox.id, id));
    return row;
  }

  private async applyBatchTerminal(
    tx: DatabaseTransaction,
    batchId: string,
    status: TerminalTaskStatus,
  ): Promise<void> {
    const [batch] = await tx.select().from(taskBatches).where(eq(taskBatches.id, batchId)).for("update");
    if (!batch || batch.finishedAt) return;
    const succeeded = batch.succeeded + (status === "succeeded" ? 1 : 0);
    const cancelled = batch.cancelled + (status === "cancelled" || status === "cancelled_with_side_effect" ? 1 : 0);
    const failed = batch.failed + (status === "failed" || status === "needs_review" ? 1 : 0);
    const completed = batch.completed + 1;
    // 用累计计数推导终态，避免「只看最后一条」把成功+取消标成 succeeded
    const batchStatus: BatchRow["status"] = completed < batch.total
      ? "running"
      : deriveBatchStatus({
        total: batch.total,
        completed,
        succeeded,
        failed,
        cancelled,
        terminalByTaskId: {},
      });
    await tx.update(taskBatches).set({
      status: batchStatus,
      completed,
      succeeded,
      failed,
      cancelled,
      updatedAt: new Date(),
      finishedAt: completed >= batch.total ? new Date() : null,
    }).where(eq(taskBatches.id, batchId));
  }
}
