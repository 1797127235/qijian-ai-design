/**
 * 异步 job 编排器：负责 job 全生命周期（创建 → prepare → 后台 work → 终态）。
 *
 * 关键不变量：
 *  - tool.execute 必须立刻 return accepted，禁止 await work（否则 pi 把 LLM 锁死）
 *  - prepare 失败 → 立刻 finalize failed 并 rethrow（让 tool 拿到 fail）
 *  - work 失败/取消 → finalize failed/cancelled（runner 自己处理，tool 不知情）
 *  - 每个 job 一个 AbortController，cancelJob/cancelProject 走这里
 */
import type { EventSink } from "../events.js";
import type { TraceRegistry } from "../tracing/index.js";
import { mapErrorFromUnknown } from "../tracing/index.js";
import type { JobWakeService } from "./job-wake.js";
import { acceptedDetails, acceptedToolText } from "./protocol.js";
import type { AgentJobStore } from "./store.js";
import type { AcceptedJobDetails, AgentJobDto, AgentJobStatus } from "./types.js";

export interface RunAsyncJobOptions {
  projectId: string;
  /** 面板生图可省略；Agent 必填 */
  threadId?: string;
  runId?: string;
  kind: string;
  input: unknown;
  /** H7：tool_call_id 写入 job span metadata，parent 始终是 root */
  toolCallId?: string;
  /** 同步世界副作用（pending 卡等），必须在 return accepted 前完成。 */
  prepare: (jobId: string) => Promise<{ artifactId?: string }>;
  /** 后台工作；勿在 tool execute 里 await。 */
  work: (ctx: {
    jobId: string;
    signal: AbortSignal;
    artifactId?: string;
  }) => Promise<{ result?: unknown; artifactId?: string } | void>;
}

export class AgentJobRunner {
  private readonly controllers = new Map<string, AbortController>();
  /** 方案 3：终态 wake（index 接线后注入；测试可省略） */
  wake?: JobWakeService;

  constructor(
    private readonly store: AgentJobStore,
    private readonly emit: EventSink,
    private readonly traces?: TraceRegistry,
  ) {}

  /** 启动时把上次进程崩溃遗留的 accepted/running job 全部标 interrupted（防幽灵任务）。 */
  async interruptStaleOnBoot() {
    const stale = await this.store.interruptStale();
    // C1：best-effort end 悬挂 Smith root
    if (this.traces?.enabled) {
      const seen = new Set<string>();
      for (const job of stale) {
        if (!job.runId || seen.has(job.runId)) continue;
        seen.add(job.runId);
        this.traces.forceClose(job.runId, {
          error_code: "INTERNAL",
          message: "服务重启或异常退出",
        });
      }
    }
    return stale.length;
  }

  /**
   * 创建 job → prepare → 启动后台 work → 立即返回 accepted。
   * 调用方在 tool.execute 中 return 此结果，不要 await work。
   */
  async run(opts: RunAsyncJobOptions): Promise<{
    text: string;
    details: AcceptedJobDetails;
  }> {
    const ctx = this.traces?.get(opts.runId);
    const job = await this.store.create({
      projectId: opts.projectId,
      threadId: opts.threadId,
      runId: opts.runId,
      kind: opts.kind,
      input: opts.input,
      traceRootId: ctx?.smithRunId,
      // A2'：job 挂 root，parent 记 root id；tool_call_id 仅 metadata
      traceParentId: ctx?.smithRunId,
    });
    if (opts.runId) this.traces?.trackJob(opts.runId, job.id);

    let artifactId: string | undefined;
    let prepareSpan = this.traces?.startSpan(opts.runId, {
      name: "job.prepare",
      run_type: "chain",
      metadata: {
        job_id: job.id,
        kind: opts.kind,
        tool_call_id: opts.toolCallId,
      },
    });
    // 尽早注册 controller，使 prepare 窗口内的 cancel 也能命中
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    try {
      const prepared = await opts.prepare(job.id);
      if (controller.signal.aborted) {
        await this.finalize(job.id, opts.projectId, opts.kind, "cancelled", {
          error: "已取消",
          artifactId: prepared.artifactId,
          errorCode: "JOB_CANCELLED",
        }, opts.runId);
        this.controllers.delete(job.id);
        throw new DOMException("已取消", "AbortError");
      }
      artifactId = prepared.artifactId;
      if (artifactId) {
        await this.store.setArtifact(job.id, artifactId);
        // H8：同 artifact 旧 active job 取消（跨面板/agent 互斥）
        const rivals = await this.store.listActiveByArtifact(opts.projectId, artifactId);
        for (const rival of rivals) {
          if (rival.id !== job.id) this.cancelJob(rival.id);
        }
      }
      this.traces?.end(prepareSpan, {
        status: "ok",
        outputs: { artifact_id: artifactId },
      });
      prepareSpan = undefined;
    } catch (error) {
      this.controllers.delete(job.id);
      const mapped = mapErrorFromUnknown(error);
      this.traces?.recordError(prepareSpan, mapped);
      prepareSpan = undefined;
      const aborted = error instanceof Error && error.name === "AbortError";
      const message = error instanceof Error ? error.message : "准备任务失败";
      // prepare 窗口 cancel 已 finalize cancelled；此处按 Abort 收口，避免误标 failed
      await this.finalize(job.id, opts.projectId, opts.kind, aborted ? "cancelled" : "failed", {
        error: aborted ? (message || "已取消") : message,
        errorCode: aborted ? "JOB_CANCELLED" : mapped.error_code,
      }, opts.runId);
      throw error;
    }

    this.emitJob(opts.projectId, { ...job, artifactId, status: "accepted" });
    if (artifactId) {
      this.emit({ type: "object_changed", projectId: opts.projectId, artifactId });
    }

    void this.executeWork(job, opts, controller, artifactId).catch((error) => {
      console.error(`Async job ${job.id} could not be finalized`, error);
    });

    const details = acceptedDetails({ ...job, artifactId }, artifactId);
    return { text: acceptedToolText(details), details };
  }

  private async executeWork(
    job: AgentJobDto,
    opts: RunAsyncJobOptions,
    controller: AbortController,
    artifactId?: string,
  ) {
    const workSpan = this.traces?.startSpan(opts.runId, {
      name: "job.work",
      run_type: "chain",
      metadata: {
        job_id: job.id,
        kind: opts.kind,
        tool_call_id: opts.toolCallId,
        artifact_id: artifactId,
      },
    });
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
        this.traces?.recordError(workSpan, {
          error_code: "JOB_CANCELLED",
          message: "已取消",
        });
        await this.finalize(job.id, opts.projectId, opts.kind, "cancelled", {
          error: "已取消",
          artifactId: outcome?.artifactId ?? artifactId,
          errorCode: "JOB_CANCELLED",
        }, opts.runId);
        return;
      }

      this.traces?.end(workSpan, {
        status: "ok",
        outputs: {
          artifact_id: outcome?.artifactId ?? artifactId,
          result: outcome?.result,
        },
      });
      await this.finalize(job.id, opts.projectId, opts.kind, "succeeded", {
        result: outcome?.result,
        artifactId: outcome?.artifactId ?? artifactId,
      }, opts.runId);
    } catch (error) {
      const aborted = controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError");
      const mapped = mapErrorFromUnknown(error, {
        aborted,
        cancelled: aborted,
      });
      this.traces?.recordError(workSpan, mapped);
      const message = error instanceof Error
        ? (aborted ? "已取消或超时" : error.message)
        : "任务失败";
      await this.finalize(job.id, opts.projectId, opts.kind, aborted ? "cancelled" : "failed", {
        error: message,
        artifactId,
        errorCode: mapped.error_code,
      }, opts.runId);
    } finally {
      this.controllers.delete(job.id);
    }
  }

  /**
   * 唯一终态出口。
   * emit job_updated + object_changed；Agent 路径 enqueue wake（事件回注轨迹）。
   */
  async finalize(
    jobId: string,
    projectId: string,
    kind: string,
    status: Extract<AgentJobStatus, "succeeded" | "failed" | "cancelled" | "interrupted">,
    patch: { result?: unknown; error?: string; artifactId?: string; errorCode?: string } = {},
    runId?: string,
  ) {
    const finSpan = runId
      ? this.traces?.startSpan(runId, {
        name: "job.finalize",
        run_type: "chain",
        metadata: {
          job_id: jobId,
          kind,
          status,
          artifact_id: patch.artifactId,
          error_code: patch.errorCode,
        },
      })
      : undefined;
    const updated = await this.store.finalize(jobId, status, patch);
    if (!updated) {
      if (runId) this.traces?.completeJob(runId, jobId);
      return;
    }
    if (status === "succeeded") {
      this.traces?.end(finSpan, {
        status: "ok",
        outputs: { artifact_id: updated.artifactId, status },
      });
    } else {
      const mapped = mapErrorFromUnknown(patch.error ?? status, {
        cancelled: status === "cancelled",
      });
      if (patch.errorCode) mapped.error_code = patch.errorCode as typeof mapped.error_code;
      this.traces?.recordError(finSpan, mapped);
    }
    this.emitJob(projectId, updated);
    if (updated.artifactId) {
      this.emit({ type: "object_changed", projectId, artifactId: updated.artifactId });
    }
    if (runId ?? updated.runId) this.traces?.completeJob(runId ?? updated.runId, jobId);
    // 方案 3：结构化事件回注（面板 job 无 thread → no-op）
    try {
      this.wake?.onJobTerminal(updated);
    } catch (error) {
      console.warn("[job-wake] onJobTerminal:", error instanceof Error ? error.message : error);
    }
  }

  /** 取消单 job。 */
  cancelJob(jobId: string) {
    this.controllers.get(jobId)?.abort();
  }

  /** Chat stop：仅当前 thread（不杀面板 thread_id=null 的 job）。 */
  async cancelThread(projectId: string, threadId: string) {
    const active = await this.store.listActiveByThread(projectId, threadId);
    for (const job of active) this.cancelJob(job.id);
    return active.length;
  }

  /** 取消该项目所有进行中 job（shutdown / 运维）。 */
  async cancelProject(projectId: string) {
    const active = await this.store.listActiveByProject(projectId);
    for (const job of active) this.cancelJob(job.id);
    return active.length;
  }

  /** 服务关停：abort 所有 in-memory controller（数据库里的会由 boot 时 interruptStale 清）。 */
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
