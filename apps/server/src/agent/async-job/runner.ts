import type { EventSink } from "../events.js";
import { acceptedDetails, acceptedToolText } from "./protocol.js";
import type { AgentJobStore } from "./store.js";
import type { AcceptedJobDetails, AgentJobDto, AgentJobStatus } from "./types.js";

export interface RunAsyncJobOptions {
  projectId: string;
  threadId: string;
  runId?: string;
  kind: string;
  input: unknown;
  /** 同步世界副作用（pending 卡等），必须在 return accepted 前完成 */
  prepare: (jobId: string) => Promise<{ artifactId?: string }>;
  /** 后台工作；勿在 tool execute 里 await */
  work: (ctx: {
    jobId: string;
    signal: AbortSignal;
    artifactId?: string;
  }) => Promise<{ result?: unknown; artifactId?: string } | void>;
}

export class AgentJobRunner {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: AgentJobStore,
    private readonly emit: EventSink,
  ) {}

  async interruptStaleOnBoot() {
    return this.store.interruptStale();
  }

  /**
   * 创建 job → prepare → 启动后台 work → 立即返回 accepted。
   * 调用方在 tool.execute 中 return 此结果，不要 await work。
   */
  async run(opts: RunAsyncJobOptions): Promise<{
    text: string;
    details: AcceptedJobDetails;
  }> {
    const job = await this.store.create({
      projectId: opts.projectId,
      threadId: opts.threadId,
      runId: opts.runId,
      kind: opts.kind,
      input: opts.input,
    });

    let artifactId: string | undefined;
    try {
      const prepared = await opts.prepare(job.id);
      artifactId = prepared.artifactId;
      if (artifactId) await this.store.setArtifact(job.id, artifactId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "准备任务失败";
      await this.finalize(job.id, opts.projectId, opts.kind, "failed", { error: message });
      throw error;
    }

    this.emitJob(opts.projectId, { ...job, artifactId, status: "accepted" });
    if (artifactId) {
      this.emit({ type: "object_changed", projectId: opts.projectId, artifactId });
    }

    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    void this.executeWork(job, opts, controller, artifactId);

    const details = acceptedDetails({ ...job, artifactId }, artifactId);
    return { text: acceptedToolText(details), details };
  }

  private async executeWork(
    job: AgentJobDto,
    opts: RunAsyncJobOptions,
    controller: AbortController,
    artifactId?: string,
  ) {
    try {
      await this.store.markRunning(job.id);
      this.emitJob(opts.projectId, {
        ...job,
        artifactId,
        status: "running",
      });

      const outcome = await opts.work({
        jobId: job.id,
        signal: controller.signal,
        artifactId,
      });

      if (controller.signal.aborted) {
        await this.finalize(job.id, opts.projectId, opts.kind, "cancelled", {
          error: "已取消",
          artifactId: outcome?.artifactId ?? artifactId,
        });
        return;
      }

      await this.finalize(job.id, opts.projectId, opts.kind, "succeeded", {
        result: outcome?.result,
        artifactId: outcome?.artifactId ?? artifactId,
      });
    } catch (error) {
      const aborted = controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError");
      const message = error instanceof Error
        ? (aborted ? "已取消或超时" : error.message)
        : "任务失败";
      await this.finalize(job.id, opts.projectId, opts.kind, aborted ? "cancelled" : "failed", {
        error: message,
        artifactId,
      });
    } finally {
      this.controllers.delete(job.id);
    }
  }

  /** 唯一终态出口（预留方案 3：此处可 enqueue wake）。 */
  async finalize(
    jobId: string,
    projectId: string,
    kind: string,
    status: Extract<AgentJobStatus, "succeeded" | "failed" | "cancelled" | "interrupted">,
    patch: { result?: unknown; error?: string; artifactId?: string } = {},
  ) {
    const updated = await this.store.finalize(jobId, status, patch);
    if (!updated) return;
    this.emitJob(projectId, updated);
    if (updated.artifactId) {
      this.emit({ type: "object_changed", projectId, artifactId: updated.artifactId });
    }
  }

  cancelJob(jobId: string) {
    this.controllers.get(jobId)?.abort();
  }

  async cancelProject(projectId: string) {
    const active = await this.store.listActiveByProject(projectId);
    for (const job of active) this.cancelJob(job.id);
    return active.length;
  }

  async shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private emitJob(projectId: string, job: Pick<AgentJobDto, "id" | "kind" | "status" | "artifactId" | "error">) {
    this.emit({
      type: "agent_job_updated",
      projectId,
      taskId: job.id,
      kind: job.kind,
      status: job.status,
      artifactId: job.artifactId,
      error: job.error,
    });
  }
}
