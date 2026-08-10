/**
 * 资产任务 BullMQ Worker：消费 image.generate / artifact.name。
 *
 * 进程入口见 `apps/server/src/task-worker.ts`。
 * 业务态在 PostgreSQL（TaskStore）；本进程只执行 handler 并 finalize。
 * 图像成功后异步入队命名（软任务），命名失败不影响图像 succeeded。
 */
import { DelayedError, Worker, type Job } from "bullmq";
import type { ServerConfig } from "../../config.js";
import { GenerationOperationStore } from "../generation-operation-store.js";
import type { ArtifactNameTaskService } from "../artifact-name-task.js";
import { handleImageGenerateTask } from "../handlers/image-generate.js";
import { ImageTaskExecutor } from "../image-task-executor.js";
import { TaskStore } from "../task-store.js";
import {
  isTerminalTaskStatus,
  taskPayloadSchema,
  type ArtifactNameTaskV1,
  type ImageGenerateTaskV1,
} from "../types.js";
import { createBullMqConnectionOptions } from "./connection.js";
import { ASSET_TASK_QUEUE_NAME } from "./queue.js";

type WorkerConfig = Pick<
  ServerConfig,
  | "redisUrl"
  | "taskQueuePrefix"
  | "taskWorkerConcurrency"
  | "taskProjectImageConcurrency"
  | "taskImageMaxAttempts"
  | "taskImageBackoffMs"
>;

export class AssetTaskWorker {
  readonly worker: Worker;
  /** 同项目同时 running 的图像任务上限；超限则 delay 再领，实现排队而非直接失败。 */
  private readonly projectImageConcurrency: number;
  private readonly imageMaxAttempts: number;
  private readonly imageBackoffMs: number;

  constructor(
    config: WorkerConfig,
    private readonly store: TaskStore,
    private readonly operations: GenerationOperationStore,
    private readonly executor: ImageTaskExecutor,
    private readonly names?: ArtifactNameTaskService,
    onError: (error: Error) => void = () => undefined,
  ) {
    this.projectImageConcurrency = config.taskProjectImageConcurrency;
    this.imageMaxAttempts = config.taskImageMaxAttempts;
    this.imageBackoffMs = config.taskImageBackoffMs;
    this.worker = new Worker(
      ASSET_TASK_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: createBullMqConnectionOptions(config.redisUrl, "worker"),
        prefix: `${config.taskQueuePrefix}:tasks`,
        concurrency: config.taskWorkerConcurrency,
      },
    );
    this.worker.on("error", onError);
  }

  /**
   * 单 job 生命周期：
   * 1) 解析 payload，读 PG 行；缺行/已终态则丢弃或回放结果
   * 2) enqueue_pending → markEnqueued
   * 3) tryMarkRunning（项目图像配额）；抢不到则 DelayedError 稍后重试
   * 4) 按 kind 执行 name / image，CAS finalize
   */
  private async process(job: Job): Promise<unknown> {
    const task = taskPayloadSchema.parse(job.data);
    const row = await this.store.get(task.task_id);
    if (!row) return { status: "discarded", reason: "task_missing" };
    // 幂等：重复投递时直接返回已写入的终态结果
    if (isTerminalTaskStatus(row.status)) return row.result ?? { status: row.status };

    if (row.status === "enqueue_pending") {
      await this.store.markEnqueued(row.id, String(job.id));
    }

    const start = await this.store.tryMarkRunning(row.id, this.projectImageConcurrency);
    if (!start.started) {
      const current = await this.store.get(row.id);
      if (current && isTerminalTaskStatus(current.status)) {
        return current.result ?? { status: current.status };
      }
      // 仅「accepted 但图像配额满」才 delayed；running 续跑已在 tryMarkRunning 返回 started
      await job.moveToDelayed(Date.now() + 1_000, job.token);
      throw new DelayedError();
    }

    try {
      if (task.kind === "artifact.name") {
        return await this.runNameTask(row.id, task);
      }
      return await this.runImageTask(row.id, row.artifactId ?? undefined, task);
    } catch (error) {
      // name 软失败不应走到这里；此处主要兜底图像 handler / 未配置 names 等硬错误
      const message = error instanceof Error ? error.message : String(error);
      const artifactId = row.artifactId ?? undefined;
      await this.store.finalize(row.id, "failed", {
        error: message,
        artifactId,
      });
      if (task.kind === "image.generate" && artifactId) {
        await this.executor.failPending(artifactId, task, message);
      }
      return { status: "failed", error: message };
    }
  }

  /** 命名任务：handle 恒返回结果对象，finalize 一律 succeeded。 */
  private async runNameTask(taskId: string, task: ArtifactNameTaskV1) {
    if (!this.names) throw new Error("artifact naming service is not configured");
    const nameResult = await this.names.handle(task);
    await this.store.finalize(taskId, "succeeded", {
      result: nameResult,
      artifactId: task.artifact_id,
    });
    return nameResult;
  }

  /**
   * 图像任务：generation_operations 幂等 + 取消检查点；
   * 成功后 best-effort 入队 artifact.name（replace 时 force 重起名）。
   */
  private async runImageTask(
    taskId: string,
    artifactId: string | undefined,
    task: ImageGenerateTaskV1,
  ) {
    const result = await handleImageGenerateTask(task, {
      operations: this.operations,
      targetArtifactId: artifactId,
      isCancellationRequested: () => this.store.isCancellationRequested(taskId),
      generate: (input) => this.executor.generate(input),
      finalize: (tx, input, operation) => this.executor.finalize(tx, input, operation),
      maxAttempts: this.imageMaxAttempts,
      backoffMs: this.imageBackoffMs,
    });

    if (result.status === "needs_review") {
      // 外部 provider 结果不明：禁止盲目重试生图
      await this.store.finalize(taskId, "needs_review", {
        error: result.error,
        artifactId,
      });
      if (artifactId) await this.executor.failPending(artifactId, task, result.error);
      return result;
    }
    if (result.status === "cancelled" || result.status === "cancelled_with_side_effect") {
      await this.store.finalize(taskId, result.status, {
        result: "result" in result ? result.result : undefined,
        artifactId,
      });
      if (artifactId) {
        await this.executor.failPending(
          artifactId,
          task,
          result.status === "cancelled_with_side_effect"
            ? "生成已取消（可能已产生中间结果）"
            : "生成已取消",
        );
      }
      return result;
    }

    await this.store.finalize(taskId, "succeeded", {
      result: result.result,
      artifactId: result.result.artifactId,
    });

    // 软后续：入队命名；submit 抛错也不得回滚图像成功
    let namingTaskId: string | undefined;
    try {
      namingTaskId = this.names
        ? await this.names.submit({
          artifactId: result.result.artifactId,
          namingInput: task.user_prompt ?? task.prompt,
          force: task.operation === "replace",
        })
        : undefined;
    } catch {
      // intentional soft path
    }
    return namingTaskId ? { ...result, naming_task_id: namingTaskId } : result;
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
