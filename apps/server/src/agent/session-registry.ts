import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatAttachmentDto } from "../services/chat-service.js";
import type { AgentImageContent } from "../services/file-storage.js";
import { formatJobsStatusBlock } from "./async-job/protocol.js";
import { agentPrompt } from "./agent-prompt.js";
import { EventWriteTracker, jsonSnapshot, persistToolEvent } from "./agent-event-persister.js";
import { buildDeskStatusBlock, selectedVisualFileIds } from "./desk-status.js";
import { SessionFactory, type SessionFactoryDependencies } from "./session-factory.js";

export type { SessionFactoryDependencies as RegistryDependencies } from "./session-factory.js";
export { agentPrompt } from "./agent-prompt.js";
export { jsonSnapshot, persistToolEvent, assistantTextFromEvent } from "./agent-event-persister.js";
export { agentSessionDir } from "./session-paths.js";

/**
 * AgentSessionRegistry：每个 (projectId, threadId) 一个 pi session，懒加载 + 空闲回收。
 *
 *  - sessions: key = "projectId:threadId" → Promise<AgentSession>（用 promise 让并发 get 去重）
 *  - idleTimers: N 分钟无活动则 dispose，腾出 pi 内部 LLM 上下文内存
 *  - activeRunIds: 同一 thread 可能有多个并发 run 排队（理论），按顺序
 *  - selectionBySession: 本轮 prompt 携带的画布选中，仅 prompt 期间有效
 */
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRunIds = new Map<string, string[]>();
  private readonly writes: EventWriteTracker;
  private readonly factory: SessionFactory;
  private readonly desks: SessionFactoryDependencies["desks"];
  private readonly generate: SessionFactoryDependencies["generate"];
  private readonly jobs: SessionFactoryDependencies["jobs"];
  private readonly jobStore: SessionFactoryDependencies["jobStore"];
  /** 本轮 prompt 的画布选中，供 generate_from_desk 默认源。 */
  private readonly selectionBySession = new Map<string, string[]>();
  private shuttingDown = false;

  constructor(
    deps: SessionFactoryDependencies,
    private readonly idleTimeoutMs = DEFAULT_SESSION_IDLE_MS,
  ) {
    this.writes = new EventWriteTracker(deps.emit);
    this.factory = new SessionFactory(deps, this.writes, this.activeRunIds, this.selectionBySession);
    this.desks = deps.desks;
    this.generate = deps.generate;
    this.jobs = deps.jobs;
    this.jobStore = deps.jobStore;
  }

  /**
   * 跑一轮对话：把「用户原文 + 桌面状态 + 后台任务状态 + 选中视觉」喂给模型。
   *  - selectedArtifactIds 来自本条 WS，不做服务端缓存（方案 1：选择跟消息走，不单独推）
   *  - 状态栏只进当轮 prompt，不写入 chat_messages（KV cache 友好）
   *  - 附件与选中视觉去重：避免同一张图作为附件和选中各传一份 base64
   *  - 完成后 awaits writes（等本次 run 的所有异步写库结束）
   */
  async prompt(
    projectId: string,
    threadId: string,
    text: string,
    attachments: ChatAttachmentDto[],
    runId: string,
    selectedArtifactIds: string[] = [],
  ) {
    const key = `${projectId}:${threadId}`;
    const pending = this.get(projectId, threadId);
    const session = await pending;
    const activeRuns = this.activeRunIds.get(key) ?? [];
    activeRuns.push(runId);
    this.activeRunIds.set(key, activeRuns);
    // 工具闭包读此 map；仅本轮有效
    this.selectionBySession.set(key, selectedArtifactIds);
    try {
      // snapshot 失败不阻断对话，状态栏降级为「暂不可用」
      const snapshot = await this.desks.snapshot(projectId).catch(() => null);
      const recentJobs = await this.jobStore?.listRecentForStatus(projectId).catch(() => []) ?? [];
      const jobsBlock = formatJobsStatusBlock(recentJobs);
      const statusBlock = [
        buildDeskStatusBlock(snapshot, selectedArtifactIds),
        jobsBlock,
      ].filter(Boolean).join("\n\n");
      const attachmentImages = await this.factory.loadAgentImages(projectId, attachments);
      // 与附件同一 file 时去重，避免双份 base64
      const selectedFileIds = selectedVisualFileIds(snapshot, selectedArtifactIds)
        .filter((fileId) => !attachments.some((attachment) => attachment.id === fileId));
      let selectedImages: AgentImageContent[] = [];
      let selectedVisualNote = "";
      if (selectedFileIds.length > 0) {
        try {
          // mediaType 占位即可：loader 以 DB stored.mediaType 为准
          selectedImages = await this.factory.loadAgentImages(
            projectId,
            selectedFileIds.map((id) => ({
              id,
              originalFilename: `selected-${id}`,
              mediaType: "image/png",
            })),
          );
        } catch {
          selectedVisualNote = "\n选中视觉：不可用";
        }
      }
      // 状态栏只拼进当轮 prompt，不写入 chat_messages
      const promptText = `${agentPrompt(text, attachments)}\n\n${statusBlock}${selectedVisualNote}`;
      await session.prompt(promptText, {
        images: [...attachmentImages, ...selectedImages],
        source: "interactive",
        streamingBehavior: session.isStreaming ? "followUp" : undefined,
      });
      await this.writes.awaitRun(runId);
    } finally {
      this.selectionBySession.delete(key);
      const index = activeRuns.indexOf(runId);
      if (index >= 0) activeRuns.splice(index, 1);
      if (activeRuns.length === 0) this.activeRunIds.delete(key);
      this.scheduleIdle(key, pending);
    }
  }

  async ensure(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.get(projectId, threadId);
    await pending;
    this.scheduleIdle(key, pending);
  }

  /**
   * 停止 thread 上的运行：先 abort 图像 HTTP + 取消 async job，再 abort session。
   * 顺序很重要：先掐外部副作用再掐 LLM loop，避免 LLM 停了但 HTTP 还在跑。
   */
  async stop(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.sessions.get(key);
    // 只 cancel 本 thread 的 jobs（job signal 会 abort complete）；不 abortProject，避免杀面板生图
    await this.jobs?.cancelThread(projectId, threadId);
    if (!pending) return true;
    try {
      const aborted = await stopAgentSession(await pending);
      return aborted || true;
    } finally {
      this.scheduleIdle(key, pending);
    }
  }

  async forget(projectId: string, threadId: string) {
    const pending = this.take(`${projectId}:${threadId}`);
    if (!pending) return false;
    await releaseAgentSession(await pending, true);
    return true;
  }

  async forgetProject(projectId: string) {
    const prefix = `${projectId}:`;
    const pending = [...this.sessions.keys()]
      .filter((key) => key.startsWith(prefix))
      .flatMap((key) => {
        const session = this.take(key);
        return session ? [session] : [];
      });
    await Promise.allSettled(pending.map(async (session) => releaseAgentSession(await session, true)));
    return pending.length;
  }

  /** 关停：清空闲计时器 → 取消 job → 释放所有 session（abort+dispose）→ drain 写库。 */
  async shutdown() {
    this.shuttingDown = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await this.jobs?.shutdown();
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (session) => releaseAgentSession(await session, true)));
    await this.writes.drain();
  }

  /**
   * 懒加载 session：不存在就建；并发 get 同一 key 共用同一个 promise（避免 race condition 双建）。
   * 异常时从 map 移除，下次重新尝试。
   */
  private get(projectId: string, threadId: string) {
    if (this.shuttingDown) throw new Error("Agent 服务正在关闭");
    const key = `${projectId}:${threadId}`;
    this.clearIdle(key);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.factory.create(projectId, threadId).catch((error) => {
        this.sessions.delete(key);
        throw error;
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  private take(key: string) {
    this.clearIdle(key);
    this.activeRunIds.delete(key);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    return pending;
  }

  private clearIdle(key: string) {
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
  }

  /** 排一个空闲回收 timer：unref 不阻塞进程退出；只有 map 里的 promise 仍是当前这个才排。 */
  private scheduleIdle(key: string, pending: Promise<AgentSession>) {
    if (this.shuttingDown || this.sessions.get(key) !== pending) return;
    this.clearIdle(key);
    const timer = setTimeout(() => void this.evictIdle(key, pending, timer), this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  private async evictIdle(key: string, pending: Promise<AgentSession>, timer: ReturnType<typeof setTimeout>) {
    if (this.idleTimers.get(key) !== timer || this.sessions.get(key) !== pending) return;
    const session = await pending.catch(() => undefined);
    if (this.idleTimers.get(key) !== timer || this.sessions.get(key) !== pending) return;
    if (session?.isStreaming) {
      this.scheduleIdle(key, pending);
      return;
    }
    this.take(key);
    session?.dispose();
  }
}

export async function stopAgentSession(session: Pick<AgentSession, "isStreaming" | "abort"> | undefined) {
  if (!session?.isStreaming) return false;
  await session.abort();
  return true;
}

export async function releaseAgentSession(
  session: Pick<AgentSession, "isStreaming" | "abort" | "dispose">,
  abortActive: boolean,
) {
  try {
    if (abortActive && session.isStreaming) await session.abort();
  } finally {
    session.dispose();
  }
}
