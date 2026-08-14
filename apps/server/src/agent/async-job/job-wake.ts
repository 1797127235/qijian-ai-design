/**
 * Job 终态 → Agent 轨迹回注（方案 3 / 书中异步事件）。
 *
 *  - 仅 agent 路径（有 threadId）且 kind 在 WAKEABLE 白名单
 *  - 短窗合并同 thread 多 job → 一条 wake（防 10 段刷屏）
 *  - thread busy 时入队，run 结束后 drain
 *  - 不 await 调用方（finalize 热路径）；错误只打日志
 */
import { AppError } from "../../lib/errors.js";
import type { ChatService } from "../../services/chat-service.js";
import type { TraceContextCarrier } from "../tracing/types.js";
import type { AgentJobDto } from "./types.js";
import {
  formatJobWakeBatchPrompt,
  formatJobWakePrompt,
  jobWakeBatchExternalId,
  jobWakeExternalId,
  shouldWakeAgentForJob,
} from "./job-event.js";

export type JobWakeDeliver = (args: {
  projectId: string;
  threadId: string;
  text: string;
  externalId: string;
  taskId: string;
  sourceTraceContext?: TraceContextCarrier;
  /** appendPrompt 已创建的 run；deliver 只跑模型，禁止再 append */
  runId: string;
  /** 已落库的 wake 消息，供前端展示 */
  message: { id: string; role: string; text: string; [k: string]: unknown };
}) => Promise<void>;

export type JobWakeBusyCheck = (projectId: string, threadId: string) => boolean;

/** 同 thread 终态短窗合并（ms）。单 job 也会等满窗，略增延迟换可合并。 */
export const JOB_WAKE_BATCH_MS = 800;

export class JobWakeService {
  private readonly queues = new Map<string, AgentJobDto[]>();
  private readonly draining = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly batchMs: number;

  constructor(
    private readonly chats: ChatService,
    private readonly deliver: JobWakeDeliver,
    private readonly isBusy: JobWakeBusyCheck = () => false,
    batchMs = JOB_WAKE_BATCH_MS,
  ) {
    this.batchMs = batchMs;
  }

  /** finalize 后调用：同步入队，debounce 后 drain。 */
  onJobTerminal(job: AgentJobDto): void {
    if (!shouldWakeAgentForJob(job)) return;
    if (!job.threadId) return;
    const key = `${job.projectId}:${job.threadId}`;
    const q = this.queues.get(key) ?? [];
    if (q.some((j) => j.id === job.id) || this.inFlight.has(job.id)) return;
    q.push(job);
    this.queues.set(key, q);
    this.scheduleFlush(key);
  }

  /** 某 thread 的 chat run 结束后调用，推进排队 wake（立即尝试，不再等窗）。 */
  notifyThreadIdle(projectId: string, threadId: string): void {
    const key = `${projectId}:${threadId}`;
    const t = this.flushTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.flushTimers.delete(key);
    }
    void this.drain(key);
  }

  private scheduleFlush(key: string): void {
    const existing = this.flushTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      void this.drain(key);
    }, this.batchMs);
    this.flushTimers.set(key, timer);
  }

  private async drain(key: string): Promise<void> {
    if (this.draining.has(key)) return;
    this.draining.add(key);
    try {
      while (true) {
        const q = this.queues.get(key);
        if (!q || q.length === 0) {
          this.queues.delete(key);
          return;
        }
        const head = q[0];
        const threadId = head.threadId!;
        if (this.isBusy(head.projectId, threadId)) return;

        // 一次取走当前队列全部，合并为一条 wake。
        // 已在 inFlight 的不 shift（避免丢终态）；其余进 batch。
        const batch: AgentJobDto[] = [];
        const deferred: AgentJobDto[] = [];
        while (q.length > 0) {
          const job = q.shift()!;
          if (this.inFlight.has(job.id)) deferred.push(job);
          else batch.push(job);
        }
        if (deferred.length > 0) {
          this.queues.set(key, deferred);
        } else {
          this.queues.delete(key);
        }

        if (batch.length === 0) {
          // 仅有 deferred：等当前 deliver 结束后再 drain（notifyThreadIdle / 下一终态）
          return;
        }

        for (const job of batch) this.inFlight.add(job.id);
        try {
          await this.deliverBatch(batch);
        } finally {
          for (const job of batch) this.inFlight.delete(job.id);
        }
      }
    } finally {
      this.draining.delete(key);
    }
  }

  private async deliverBatch(jobs: AgentJobDto[]): Promise<void> {
    const job = jobs[0];
    if (!job) return;
    const threadId = job.threadId;
    if (!threadId) return;

    const externalId = jobs.length === 1
      ? jobWakeExternalId(job.id)
      : jobWakeBatchExternalId(jobs.map((j) => j.id));
    const text = jobs.length === 1
      ? formatJobWakePrompt(job)
      : formatJobWakeBatchPrompt(jobs);

    try {
      const saved = await this.chats.appendPrompt(
        job.projectId,
        threadId,
        text,
        externalId,
        [],
      );
      if (!saved.created || !saved.run) return;

      await this.deliver({
        projectId: job.projectId,
        threadId,
        text: saved.message.text,
        externalId,
        taskId: job.id,
        sourceTraceContext: job.traceContext,
        runId: saved.run.id,
        message: saved.message as { id: string; role: string; text: string },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "ATTACHMENT_BUSY") {
        const key = `${job.projectId}:${threadId}`;
        const q = this.queues.get(key) ?? [];
        for (const j of jobs) {
          if (!q.some((x) => x.id === j.id)) q.push(j);
        }
        this.queues.set(key, q);
        return;
      }
      console.warn(
        `[job-wake] deliver failed tasks=${jobs.map((j) => j.id).join(",")}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
