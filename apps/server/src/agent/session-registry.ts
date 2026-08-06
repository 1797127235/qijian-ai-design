import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatAttachmentDto } from "../services/chat-service.js";
import { EventWriteTracker, jsonSnapshot, persistToolEvent } from "./agent-event-persister.js";
import { SessionFactory, type SessionFactoryDependencies } from "./session-factory.js";
import { agentPrompt, loadHistoricalVisuals, restoreChatMessages } from "./session-restore.js";

export type { SessionFactoryDependencies as RegistryDependencies } from "./session-factory.js";
export { jsonSnapshot, persistToolEvent, assistantTextFromEvent } from "./agent-event-persister.js";
export { agentPrompt, loadHistoricalVisuals, restoreChatMessages } from "./session-restore.js";

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRunIds = new Map<string, string[]>();
  private readonly writes: EventWriteTracker;
  private readonly factory: SessionFactory;
  private shuttingDown = false;

  constructor(
    deps: SessionFactoryDependencies,
    private readonly idleTimeoutMs = DEFAULT_SESSION_IDLE_MS,
  ) {
    this.writes = new EventWriteTracker(deps.emit);
    this.factory = new SessionFactory(deps, this.writes, this.activeRunIds);
  }

  async prompt(projectId: string, threadId: string, text: string, attachments: ChatAttachmentDto[], runId: string) {
    const key = `${projectId}:${threadId}`;
    const pending = this.get(projectId, threadId);
    const session = await pending;
    const activeRuns = this.activeRunIds.get(key) ?? [];
    activeRuns.push(runId);
    this.activeRunIds.set(key, activeRuns);
    try {
      const images = await this.factory.loadAgentImages(projectId, attachments);
      await session.prompt(agentPrompt(text, attachments), {
        images,
        source: "interactive",
        streamingBehavior: session.isStreaming ? "followUp" : undefined,
      });
      await this.writes.awaitRun(runId);
    } finally {
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
    if (!pending) return false;
    try {
      return await stopAgentSession(await pending);
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
