import type { OutboxRow } from "./task-store.js";
import type { TerminalTaskStatus } from "./task-queue.js";

type ReconcileTask = {
  id: string;
  queueJobId: string | null;
  status: string;
};

export interface ReconcilerStore {
  reclaimStaleOutbox(staleMs: number, limit: number): Promise<OutboxRow[]>;
  listOutbox(status: OutboxRow["status"], limit: number): Promise<OutboxRow[]>;
  get(taskId: string): Promise<ReconcileTask | undefined>;
  requeueEnqueuedOutbox(id: string, error: string): Promise<OutboxRow | undefined>;
  finalize(
    taskId: string,
    status: TerminalTaskStatus,
    patch: { error?: string },
  ): Promise<unknown | undefined>;
}

/** Redis 侧 job 调度态；missing = 无记录（已删或从未入队成功）。 */
export type QueueJobState =
  | "missing"
  | "waiting"
  | "delayed"
  | "active"
  | "completed"
  | "failed"
  | "paused"
  | "unknown";

export interface QueueJobLookup {
  getJobState(jobId: string): Promise<QueueJobState>;
}

export type ReconcileSummary = {
  reclaimed: number;
  requeued: number;
  needsReview: number;
  redisErrors: number;
};

/** 这些态表示调度已结束，Worker 不会再推进；PG 若仍 active 即为僵尸。 */
const REDIS_DEAD: ReadonlySet<QueueJobState> = new Set(["missing", "completed", "failed"]);

export class TaskQueueReconciler {
  constructor(
    private readonly store: ReconcilerStore,
    private readonly queue: QueueJobLookup,
    private readonly options: { staleClaimMs?: number; limit?: number } = {},
  ) {}

  async reconcileOnce(): Promise<ReconcileSummary> {
    const limit = this.options.limit ?? 100;
    const reclaimed = await this.store.reclaimStaleOutbox(this.options.staleClaimMs ?? 60_000, limit);
    const summary: ReconcileSummary = {
      reclaimed: reclaimed.length,
      requeued: 0,
      needsReview: 0,
      redisErrors: 0,
    };
    const rows = await this.store.listOutbox("enqueued", limit);
    for (const row of rows) {
      const task = await this.store.get(row.taskId);
      if (!task || !task.queueJobId) continue;
      let state: QueueJobState;
      try {
        state = await this.queue.getJobState(task.queueJobId);
      } catch {
        summary.redisErrors += 1;
        continue;
      }
      if (!REDIS_DEAD.has(state)) continue;

      if (task.status === "accepted" || task.status === "enqueue_pending") {
        // 仅 job 丢失可安全 requeue；completed/failed 同 jobId 无法再 add，收口人工
        if (state === "missing") {
          if (await this.store.requeueEnqueuedOutbox(
            row.id,
            "BullMQ job missing; scheduled for reconciliation",
          )) {
            summary.requeued += 1;
          }
        } else if (await this.store.finalize(task.id, "needs_review", {
          error: `BullMQ job ${state} while task was still ${task.status}`,
        })) {
          summary.needsReview += 1;
        }
      } else if (task.status === "running") {
        // running + Redis 终态/缺失：禁止盲目重放 generate（可能已开画）
        if (await this.store.finalize(task.id, "needs_review", {
          error: state === "missing"
            ? "BullMQ job missing while task was running"
            : `BullMQ job ${state} while task was still running`,
        })) {
          summary.needsReview += 1;
        }
      }
    }
    return summary;
  }
}
