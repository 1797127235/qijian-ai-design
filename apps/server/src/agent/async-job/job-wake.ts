/**
 * Job 终态 → Agent 轨迹回注（方案 3 / 书中异步事件）。
 *
 *  - 仅 agent 路径（有 threadId）且 kind 在 WAKEABLE 白名单
 *  - 一 job 一 wake（appendPrompt externalId 幂等）
 *  - thread busy 时入队，run 结束后 drain
 *  - 不 await 调用方（finalize 热路径）；错误只打日志
 */
import { AppError } from "../../lib/errors.js";
import type { ChatService } from "../../services/chat-service.js";
import type { AgentJobDto } from "./types.js";
import {
  formatJobWakePrompt,
  jobWakeExternalId,
  shouldWakeAgentForJob,
} from "./job-event.js";

export type JobWakeDeliver = (args: {
  projectId: string;
  threadId: string;
  text: string;
  externalId: string;
  taskId: string;
  /** appendPrompt 已创建的 run；deliver 只跑模型，禁止再 append */
  runId: string;
  /** 已落库的 wake 消息，供前端展示 */
  message: { id: string; role: string; text: string; [k: string]: unknown };
}) => Promise<void>;

export type JobWakeBusyCheck = (projectId: string, threadId: string) => boolean;

export class JobWakeService {
  private readonly queues = new Map<string, AgentJobDto[]>();
  private readonly draining = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly chats: ChatService,
    private readonly deliver: JobWakeDeliver,
    private readonly isBusy: JobWakeBusyCheck = () => false,
  ) {}

  /** finalize 后调用：同步入队，异步 drain。 */
  onJobTerminal(job: AgentJobDto): void {
    if (!shouldWakeAgentForJob(job)) return;
    if (!job.threadId) return;
    const key = `${job.projectId}:${job.threadId}`;
    const q = this.queues.get(key) ?? [];
    if (q.some((j) => j.id === job.id) || this.inFlight.has(job.id)) return;
    q.push(job);
    this.queues.set(key, q);
    void this.drain(key);
  }

  /** 某 thread 的 chat run 结束后调用，推进排队 wake。 */
  notifyThreadIdle(projectId: string, threadId: string): void {
    void this.drain(`${projectId}:${threadId}`);
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
        const job = q[0];
        const threadId = job.threadId!;
        if (this.isBusy(job.projectId, threadId)) return;

        q.shift();
        if (q.length === 0) this.queues.delete(key);
        else this.queues.set(key, q);

        if (this.inFlight.has(job.id)) continue;
        this.inFlight.add(job.id);
        try {
          await this.deliverOne(job);
        } finally {
          this.inFlight.delete(job.id);
        }
      }
    } finally {
      this.draining.delete(key);
    }
  }

  private async deliverOne(job: AgentJobDto): Promise<void> {
    const threadId = job.threadId;
    if (!threadId) return;
    const externalId = jobWakeExternalId(job.id);
    const text = formatJobWakePrompt(job);

    try {
      // 幂等：已投递过则跳过（created=false）
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
        runId: saved.run.id,
        message: saved.message as { id: string; role: string; text: string },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "ATTACHMENT_BUSY") {
        // 竞态：再入队尾部稍后重试
        const key = `${job.projectId}:${threadId}`;
        const q = this.queues.get(key) ?? [];
        if (!q.some((j) => j.id === job.id)) {
          q.push(job);
          this.queues.set(key, q);
        }
        return;
      }
      console.warn(
        `[job-wake] deliver failed task=${job.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
