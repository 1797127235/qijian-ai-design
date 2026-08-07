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
  /** 本轮 prompt 的画布选中，供 generate_from_desk 默认源 */
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
   * 跑一轮对话：用户原文 + 桌面状态栏（及可选选中图）进模型。
   * selectedArtifactIds 来自本条 WS，服务端不缓存选中（方案 1）。
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

  async stop(projectId: string, threadId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.sessions.get(key);
    // 先掐图像 HTTP + async jobs，再 abort session
    this.generate?.abortProject?.(projectId);
    await this.jobs?.cancelProject(projectId);
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
