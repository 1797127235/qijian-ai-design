import { FlowProducer, Queue, type FlowJob, type JobNode } from "bullmq";
import type { ServerConfig } from "../../config.js";
import { taskPayloadSchema, type TaskPayload } from "../types.js";
import { createBullMqConnectionOptions } from "./connection.js";

export const ASSET_TASK_QUEUE_NAME = "asset-tasks";
export const TASK_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const RETENTION = { age: TASK_JOB_RETENTION_SECONDS } as const;

export type StableTaskFlow = {
  payload: TaskPayload;
  children?: StableTaskFlow[];
};

type BullMqQueueConfig = Pick<ServerConfig, "redisUrl" | "taskQueuePrefix">;

function toFlowJob(node: StableTaskFlow): FlowJob {
  const payload = taskPayloadSchema.parse(node.payload);
  return {
    name: payload.kind,
    queueName: ASSET_TASK_QUEUE_NAME,
    data: payload,
    opts: {
      jobId: payload.task_id,
      attempts: 1,
      removeOnComplete: RETENTION,
      removeOnFail: RETENTION,
    },
    children: node.children?.map(toFlowJob),
  };
}

export class BullMqQueueAdapter {
  readonly queue: Queue<TaskPayload, unknown, TaskPayload["kind"]>;
  readonly flowProducer: FlowProducer;
  private closing?: Promise<void>;

  constructor(config: BullMqQueueConfig) {
    const connection = createBullMqConnectionOptions(config.redisUrl);
    const prefix = `${config.taskQueuePrefix}:tasks`;
    this.queue = new Queue<TaskPayload, unknown, TaskPayload["kind"]>(ASSET_TASK_QUEUE_NAME, {
      connection,
      prefix,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: RETENTION,
        removeOnFail: RETENTION,
      },
    });
    this.flowProducer = new FlowProducer({ connection, prefix });
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([
      this.queue.waitUntilReady(),
      this.flowProducer.waitUntilReady(),
    ]);
  }

  async enqueue(rawPayload: TaskPayload) {
    const payload = taskPayloadSchema.parse(rawPayload);
    return this.queue.add(payload.kind, payload, { jobId: payload.task_id });
  }

  async enqueueFlow(flow: StableTaskFlow): Promise<JobNode> {
    return this.flowProducer.add(toFlowJob(flow));
  }

  async cancelJob(taskId: string): Promise<boolean> {
    const job = await this.queue.getJob(taskId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed") return false;
    await job.remove();
    return true;
  }

  /** Reconciler 用：返回统一调度态，缺 job 时为 missing。 */
  async getJobState(jobId: string): Promise<
    "missing" | "waiting" | "delayed" | "active" | "completed" | "failed" | "paused" | "unknown"
  > {
    const job = await this.queue.getJob(jobId);
    if (!job) return "missing";
    const state = await job.getState();
    if (
      state === "waiting"
      || state === "delayed"
      || state === "active"
      || state === "completed"
      || state === "failed"
    ) {
      return state;
    }
    // prioritized / waiting-children / 其它 → 仍在调度中，按 unknown 留给 active 侧放行
    return "unknown";
  }

  shutdown(): Promise<void> {
    this.closing ??= Promise.all([
      this.queue.close(),
      this.flowProducer.close(),
    ]).then(() => undefined);
    return this.closing;
  }
}
