import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DeskSnapshot } from "../domain/types.js";
import type { ChatAttachmentDto } from "../services/chat-service.js";
import type { AgentImageContent } from "../services/file-storage.js";
import { formatJobsStatusBlock } from "./async-job/protocol.js";
import { agentPrompt } from "./agent-prompt.js";
import { EventWriteTracker, jsonSnapshot, persistToolEvent } from "./agent-event-persister.js";
import {
  assembleDeskContext,
  deskFileIds,
  formatInspectBlock,
  planInspectSelection,
  type DeskObjectView,
  type InspectImageRef,
  type InspectPlan,
  type ReferenceResolution,
} from "./desk-status.js";
import { SessionFactory, type SessionFactoryDependencies } from "./session-factory.js";
import {
  CAPTION_ANALYZER_VERSION,
  sanitizeCaptionText,
} from "../services/image-caption-sanitize.js";
import type { ImageCaptionStore } from "../services/image-caption-store.js";
import type { JobWakeService } from "./async-job/job-wake.js";

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
  private readonly taskCancellation: SessionFactoryDependencies["taskCancellation"];
  private readonly jobStore: SessionFactoryDependencies["jobStore"];
  private readonly files: SessionFactoryDependencies["files"];
  private readonly captions?: ImageCaptionStore;
  private readonly chats: SessionFactoryDependencies["chats"];
  private readonly emit: SessionFactoryDependencies["emit"];
  private readonly traces?: SessionFactoryDependencies["traces"];
  /** 本轮 prompt 的画布选中，供 generate_from_desk 默认源。 */
  private readonly selectionBySession = new Map<string, string[]>();
  private shuttingDown = false;
  private jobWake?: JobWakeService;

  constructor(
    deps: SessionFactoryDependencies,
    private readonly idleTimeoutMs = DEFAULT_SESSION_IDLE_MS,
  ) {
    this.writes = new EventWriteTracker(deps.emit);
    this.factory = new SessionFactory(deps, this.writes, this.activeRunIds, this.selectionBySession);
    this.desks = deps.desks;
    this.taskCancellation = deps.taskCancellation;
    this.jobStore = deps.jobStore;
    this.files = deps.files;
    this.captions = deps.captions;
    this.chats = deps.chats;
    this.emit = deps.emit;
    this.traces = deps.traces;
  }

  setJobWake(jobWake: JobWakeService) {
    this.jobWake = jobWake;
  }

  /** thread 是否有进行中的 agent run（wake 互斥）。 */
  isThreadBusy(projectId: string, threadId: string): boolean {
    const runs = this.activeRunIds.get(`${projectId}:${threadId}`);
    return Boolean(runs && runs.length > 0);
  }

  /**
   * Job 终态 wake：DESK + JOB_EVENT 已写在 text 里时仍刷新桌面局面。
   * 调用方须已 appendPrompt 得到 runId；本方法只跑模型与 finish。
   */
  async runJobWake(args: {
    projectId: string;
    threadId: string;
    runId: string;
    text: string;
  }): Promise<void> {
    const { projectId, threadId, runId, text } = args;
    try {
      await this.prompt(projectId, threadId, text, [], runId, []);
      const outcome = await this.chats.summarizeRunTools(runId);
      const statusMessage = await this.chats.finishRun(runId, outcome.status, outcome.error);
      if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
      this.traces?.markProductFinished(runId, {
        status: outcome.status === "failed" ? "error" : "ok",
        outputs: { run_status: outcome.status, wake: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "job wake 失败";
      const statusMessage = await this.chats.finishRun(runId, "failed", message);
      if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
      this.traces?.markProductFinished(runId, {
        status: "error",
        outputs: { run_status: "failed", wake: true },
      });
      throw error;
    }
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
      const fileNames = snapshot
        ? await this.files.originalFilenames(projectId, deskFileIds(snapshot)).catch(() => ({}))
        : {};
      // 先无 caption 装配一次，拿到 core focus file_ids，再批量 preload（超时则跳过）
      const draft = assembleDeskContext(snapshot, selectedArtifactIds, {
        fileNames,
        userText: text,
      });
      const captions = await this.preloadCaptions(projectId, draft.objects, selectedArtifactIds, draft.resolution);
      const assembled = captions && Object.keys(captions).length > 0
        ? assembleDeskContext(snapshot, selectedArtifactIds, {
          fileNames,
          userText: text,
          captions,
        })
        : draft;
      const aliasById = new Map(assembled.objects.map((o) => [o.id, o.alias]));
      const attachmentImages = await this.factory.loadAgentImages(projectId, attachments);
      // Inspect：选中 ∪ 唯一指代结果（assemble 已合并进 inspectPlan）
      const inspectIds = [
        ...selectedArtifactIds,
        ...(assembled.resolution?.unique ? assembled.resolution.resolvedIds : []),
      ];
      const { selectedImages, inspectPlan, imageRefs } = await this.loadInspectVisuals(
        projectId,
        snapshot,
        inspectIds,
        attachments,
        attachmentImages.length,
      );
      const inspectBlock = formatInspectBlock(
        inspectPlan,
        attachmentImages.length + 1,
        imageRefs,
        aliasById,
      );
      const deskBlocks = [
        assembled.text,
        jobsBlock,
        inspectBlock,
      ].filter(Boolean).join("\n\n");
      const promptText = `${agentPrompt(text, attachments)}\n\n${deskBlocks}`;
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
      // 通知 wake 队列：本 thread 可能已空闲
      this.jobWake?.notifyThreadIdle(projectId, threadId);
    }
  }

  /**
   * 预加载 core focus 的 caption（仅 cache hit；失败/超时 → 空，不堵流）。
   * Survey 不读 caption。
   */
  private async preloadCaptions(
    projectId: string,
    objects: DeskObjectView[],
    selectedArtifactIds: string[],
    resolution: ReferenceResolution | null,
  ): Promise<Record<string, string>> {
    if (!this.captions) return {};
    const byId = new Map(objects.map((o) => [o.id, o]));
    const coreIds: string[] = [];
    for (const id of selectedArtifactIds) {
      if (byId.has(id) && !coreIds.includes(id)) coreIds.push(id);
    }
    if (resolution?.unique) {
      for (const id of resolution.resolvedIds) {
        if (byId.has(id) && !coreIds.includes(id)) coreIds.push(id);
      }
    }
    const fileIds = coreIds
      .map((id) => byId.get(id)?.fileId)
      .filter((id): id is string => Boolean(id));
    if (fileIds.length === 0) return {};

    const work = async (): Promise<Record<string, string>> => {
      const hashes = await this.captions!.fileHashes(projectId, fileIds);
      const keys = fileIds
        .map((fileId) => {
          const contentHash = hashes.get(fileId);
          if (!contentHash) return null;
          return { fileId, contentHash, analyzerVersion: CAPTION_ANALYZER_VERSION };
        })
        .filter((k): k is { fileId: string; contentHash: string; analyzerVersion: string } => Boolean(k));
      if (keys.length === 0) return {};
      const hits = await this.captions!.getMany(projectId, keys);
      const out: Record<string, string> = {};
      for (const [fileId, hit] of hits) {
        const safe = sanitizeCaptionText(hit.text);
        if (safe) out[fileId] = safe;
      }
      return out;
    };

    try {
      return await Promise.race([
        work(),
        new Promise<Record<string, string>>((resolve) => {
          setTimeout(() => resolve({}), 80);
        }),
      ]);
    } catch {
      return {};
    }
  }

  /**
   * 选中 → Inspect 计划 → 加载像素（与附件 file 去重）→ imageRefs 供 [INSPECT] 文本。
   */
  private async loadInspectVisuals(
    projectId: string,
    snapshot: DeskSnapshot | null,
    selectedArtifactIds: string[],
    attachments: ChatAttachmentDto[],
    attachmentImageCount: number,
  ): Promise<{
    selectedImages: AgentImageContent[];
    inspectPlan: InspectPlan;
    imageRefs: InspectImageRef[];
  }> {
    const plan = planInspectSelection(snapshot, selectedArtifactIds);
    if (plan.included.length === 0) {
      return { selectedImages: [], inspectPlan: plan, imageRefs: [] };
    }
    const attachmentFileIds = new Set(attachments.map((a) => a.id));
    const viaAttachment = plan.included.filter((item) => attachmentFileIds.has(item.fileId));
    const toLoad = plan.included.filter((item) => !attachmentFileIds.has(item.fileId));

    let selectedImages: AgentImageContent[] = [];
    let loadFailed = false;
    if (toLoad.length > 0) {
      try {
        selectedImages = await this.factory.loadAgentImages(
          projectId,
          toLoad.map((item) => ({
            id: item.fileId,
            originalFilename: `selected-${item.artifactId}`,
            mediaType: "image/png",
          })),
        );
      } catch {
        loadFailed = true;
        selectedImages = [];
      }
    }

    const imageRefs: InspectImageRef[] = [];
    const skipped = [...plan.skipped];
    const includedOk: InspectPlan["included"] = [];

    for (const item of viaAttachment) {
      includedOk.push(item);
      imageRefs.push({ artifactId: item.artifactId, fileId: item.fileId, kind: "attachment" });
    }

    if (loadFailed) {
      for (const item of toLoad) {
        skipped.push({ artifactId: item.artifactId, reason: "empty" });
      }
    } else {
      // loader 按 attachments 顺序返回；张数不足则尾部视为失败
      const loadedCount = Math.min(selectedImages.length, toLoad.length);
      for (let i = 0; i < loadedCount; i++) {
        const item = toLoad[i];
        includedOk.push(item);
        imageRefs.push({
          artifactId: item.artifactId,
          fileId: item.fileId,
          kind: "image",
          imageIndex: attachmentImageCount + i + 1,
        });
      }
      for (let i = loadedCount; i < toLoad.length; i++) {
        skipped.push({ artifactId: toLoad[i].artifactId, reason: "empty" });
      }
      // 若 loader 返回更少，截断 selectedImages 与 refs 对齐
      selectedImages = selectedImages.slice(0, loadedCount);
    }

    return {
      selectedImages,
      inspectPlan: { included: includedOk, skipped },
      imageRefs,
    };
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
    await this.taskCancellation?.cancelThread(projectId, threadId);
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
