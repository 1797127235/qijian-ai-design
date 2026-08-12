import { randomUUID } from "node:crypto";
import { imageRetryBackoffMs } from "./state-machine.js";
import type { OutboxRow } from "./task-store.js";
import type { TerminalTaskStatus } from "./task-queue.js";
import { taskPayloadSchema, type TaskPayload } from "./types.js";

export interface OutboxEnqueueQueue {
  enqueue(payload: TaskPayload): Promise<{ id?: string | number }>;
}

export interface DispatcherStore {
  claimOutbox(owner: string, limit: number): Promise<OutboxRow[]>;
  failOutbox(id: string, error: string): Promise<OutboxRow | undefined>;
  markEnqueued(taskId: string, queueJobId: string): Promise<unknown | undefined>;
  markOutboxEnqueued(id: string): Promise<OutboxRow | undefined>;
  releaseOutbox(id: string, error: string, delayMs: number): Promise<OutboxRow | undefined>;
  finalize(
    taskId: string,
    status: TerminalTaskStatus,
    patch?: { error?: string; artifactId?: string },
  ): Promise<{ artifactId?: string | null } | undefined | unknown>;
  get?(taskId: string): Promise<{ artifactId?: string | null } | undefined>;
}

export type DispatchSummary = {
  claimed: number;
  enqueued: number;
  released: number;
  failed: number;
  /** enqueue 失败达上限：outbox failed + 业务任务 failed */
  deadLettered: number;
};

export type OutboxDeadLetterHook = (input: {
  taskId: string;
  artifactId?: string;
  payload: TaskPayload;
  error: string;
}) => Promise<void>;

export class TaskOutboxDispatcher {
  private readonly owner: string;
  private readonly limit: number;
  private readonly retryBaseMs: number;
  /** 含本轮，enqueue 失败累计达此次数 → 死信 */
  private readonly maxAttempts: number;
  private readonly onDeadLetter?: OutboxDeadLetterHook;

  constructor(
    private readonly store: DispatcherStore,
    private readonly queue: OutboxEnqueueQueue,
    options: {
      owner?: string;
      limit?: number;
      /** 退避基数 ms；兼容旧名 retryDelayMs */
      retryBaseMs?: number;
      retryDelayMs?: number;
      maxAttempts?: number;
      onDeadLetter?: OutboxDeadLetterHook;
    } = {},
  ) {
    this.owner = options.owner?.trim() || `dispatcher-${randomUUID()}`;
    this.limit = options.limit ?? 20;
    this.retryBaseMs = options.retryBaseMs ?? options.retryDelayMs ?? 1_000;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 20));
    this.onDeadLetter = options.onDeadLetter;
  }

  async dispatchOnce(): Promise<DispatchSummary> {
    const rows = await this.store.claimOutbox(this.owner, this.limit);
    const summary: DispatchSummary = {
      claimed: rows.length,
      enqueued: 0,
      released: 0,
      failed: 0,
      deadLettered: 0,
    };
    for (const row of rows) {
      let payload: TaskPayload;
      try {
        payload = taskPayloadSchema.parse(row.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (await this.store.failOutbox(row.id, message)) {
          summary.failed += 1;
          await this.store.finalize(row.taskId, "failed", {
            error: `outbox payload invalid: ${message}`.slice(0, 2_000),
          });
        }
        continue;
      }

      try {
        const job = await this.queue.enqueue(payload);
        const queueJobId = String(job.id ?? payload.task_id);
        const task = await this.store.markEnqueued(row.taskId, queueJobId);
        if (!task) await this.store.markOutboxEnqueued(row.id);
        summary.enqueued += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // attempts = 已失败次数；本轮若再失败将变成 attempts+1
        if (row.attempts + 1 >= this.maxAttempts) {
          await this.deadLetter(row, payload, message);
          summary.deadLettered += 1;
        } else if (await this.store.releaseOutbox(
          row.id,
          message,
          imageRetryBackoffMs(row.attempts, this.retryBaseMs),
        )) {
          summary.released += 1;
        }
      }
    }
    return summary;
  }

  private async deadLetter(row: OutboxRow, payload: TaskPayload, error: string): Promise<void> {
    const deadError = `outbox enqueue exhausted after ${this.maxAttempts} attempts: ${error}`
      .slice(0, 2_000);
    if (!(await this.store.failOutbox(row.id, deadError))) return;
    const task = await this.store.get?.(row.taskId);
    const artifactId = task?.artifactId ?? undefined;
    await this.store.finalize(row.taskId, "failed", { error: deadError, artifactId });
    try {
      await this.onDeadLetter?.({
        taskId: row.taskId,
        artifactId,
        payload,
        error: deadError,
      });
    } catch {
      // best-effort：主路径已 failOutbox + finalize
    }
    console.warn(
      `[bullmq] outbox dead-letter task=${row.taskId} attempts=${this.maxAttempts}: ${error}`,
    );
  }
}
