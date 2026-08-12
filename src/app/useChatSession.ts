/**
 * 项目级聊天会话：WS 生命周期、线程 CRUD、发送/停止、过程时间线。
 *
 * 边界：
 *  - process 归约在 chatProcess.ts（纯函数）
 *  - 画布落桌/history 由 onDeskObjectChanged 回调给 DeskWorkbench
 *  - 不持有 desk snapshot，只在 object_changed 时 refreshDesk
 */
import { useCallback, useRef, useState, type MutableRefObject } from "react";
import {
  api,
  connectChat,
  isInternalSystemChatMessage,
  type ChatConnectionStatus,
  type ChatThread,
  type DeskSnapshot,
} from "../lib/api";
import type { ChatItem, ProcessSnapshot } from "../desk/types";
import { nextId } from "./ids";
import {
  PROCESS_ITEM_ID,
  applyAgentInnerEvent,
  finalizeProcessItem,
  settleProcessError,
  settleProcessStopped,
  upsertProcessItem,
  type AgentInnerEvent,
  type ProcessApplyResult,
} from "./chatProcess";

function toVisibleChatItems(
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    attachments?: import("../lib/api").ChatAttachment[];
    externalId?: string;
  }>,
): ChatItem[] {
  return messages
    .filter((message) => !isInternalSystemChatMessage(message))
    .map((message) => ({
      id: message.id,
      role: message.role === "assistant" ? ("agent" as const) : ("user" as const),
      text: message.text,
      attachments: message.attachments,
    }));
}

export function useChatSession(options: {
  activeProjectRef: MutableRefObject<string | undefined>;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  /** Agent 落桌 effect：DeskWorkbench 用它记 history（与面板生图 gate 去重） */
  onDeskObjectChanged?: (projectId: string, artifactId: string | undefined, snap: DeskSnapshot) => void;
  /** 自动起名落地：同步顶栏/列表 */
  onProjectRenamed?: (projectId: string, name: string) => void;
}) {
  const { activeProjectRef, refreshDesk } = options;
  const onDeskObjectChangedRef = useRef(options.onDeskObjectChanged);
  onDeskObjectChangedRef.current = options.onDeskObjectChanged;
  const onProjectRenamedRef = useRef(options.onProjectRenamed);
  onProjectRenamedRef.current = options.onProjectRenamed;
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeChatThreadId, setActiveChatThreadId] = useState<string>();
  const [threadChanging, setThreadChanging] = useState(false);
  const [streaming, setStreaming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [connection, setConnection] = useState<ChatConnectionStatus>("disconnected");
  const [submissionOutcome, setSubmissionOutcome] = useState<{
    clientMessageId: string;
    status: "acknowledged" | "rejected";
  }>();
  const [focusFromAgent, setFocusFromAgent] = useState<{ id: string; token: number }>();

  const chatRef = useRef<ReturnType<typeof connectChat>>();
  const streamBuf = useRef("");
  const processRef = useRef<ProcessSnapshot | null>(null);
  const activeChatThreadRef = useRef<string>();
  const threadLoadSequence = useRef(0);
  const pendingPromptIdRef = useRef<string>();
  /** 最近一条待确认 prompt 的完整输入：ATTACHMENT_BUSY 时自动重试用 */
  const lastPromptRef = useRef<{
    text: string;
    attachmentIds: string[];
    clientMessageId: string;
    selectedArtifactIds?: string[];
  }>();
  const busyRetryRef = useRef<{ clientMessageId: string; attempts: number; timer?: number }>();
  const chatThreadsRef = useRef<ChatThread[]>([]);
  // 每次 chatThreads 变化同步到 ref，让回调可以从 ref 读取最新值，无需把它放进 deps
  chatThreadsRef.current = chatThreads;

  const MAX_BUSY_RETRIES = 20;
  const BUSY_RETRY_MS = 1500;
  /** 本地 busy 兜底：agent_settled 丢失时避免发送按钮永久停在「停止」 */
  const BUSY_WATCHDOG_MS = 3 * 60 * 1000;
  const busyWatchdogRef = useRef<number>();

  const clearBusyWatchdog = useCallback(() => {
    window.clearTimeout(busyWatchdogRef.current);
    busyWatchdogRef.current = undefined;
  }, []);

  const armBusyWatchdog = useCallback(() => {
    window.clearTimeout(busyWatchdogRef.current);
    busyWatchdogRef.current = window.setTimeout(() => {
      if (!busyRef.current) return;
      busyRef.current = false;
      setBusy(false);
      streamBuf.current = "";
      setStreaming(undefined);
      if (processRef.current) {
        setChatItems((cur) => settleProcessError(cur, processRef.current, "任务状态同步超时，已解锁输入；可重试发送或点停止后继续。").items);
        processRef.current = null;
      } else {
        setChatItems((cur) => [...cur, {
          id: nextId(),
          role: "agent",
          text: "任务状态同步超时，已解锁输入；可重试发送。",
        }]);
      }
    }, BUSY_WATCHDOG_MS);
  }, []);

  /**
   * 纯函数结果 → React state。
   * finalize 时 processRef 置 null：下一轮 agent_start 从 emptyProcess 起，不污染已落历史的卡。
   */
  const commitProcessResult = useCallback((result: ProcessApplyResult) => {
    processRef.current = result.process;
    if (result.streamDelta) {
      streamBuf.current += result.streamDelta;
      setStreaming(streamBuf.current);
    }
    if (result.clearStream) {
      streamBuf.current = "";
      setStreaming(undefined);
    }
    if (result.busy !== undefined) {
      busyRef.current = result.busy;
      setBusy(result.busy);
      if (result.busy) armBusyWatchdog();
      else clearBusyWatchdog();
    }
    if (result.chatItems === "upsert" && result.process) {
      setChatItems((cur) => upsertProcessItem(cur, {
        ...result.process!,
        steps: result.process!.steps.map((s) => ({ ...s })),
      }));
    } else if (result.chatItems === "finalize" && result.process) {
      setChatItems((cur) => finalizeProcessItem(cur, result.process!));
      processRef.current = null;
    } else if (result.chatItems === "clear") {
      setChatItems((cur) => cur.filter((item) => item.id !== PROCESS_ITEM_ID));
    }
  }, [armBusyWatchdog, clearBusyWatchdog]);

  /**
   * 上一轮服务端仍在跑（ATTACHMENT_BUSY）时的安静重试。
   * 关键：不得用本地 busy 闸住重试——sendChat 在发出前会 setBusy(true)，
   * 若此处再等 !busy，会永远空转直到封顶（表现为「再发就卡死」）。
   * 服务端 running 才是真相；重试只负责再抛 prompt，幂等靠 externalId。
   */
  const scheduleBusyRetry = (input: {
    text: string;
    attachmentIds: string[];
    clientMessageId: string;
    selectedArtifactIds?: string[];
  }) => {
    const prev = busyRetryRef.current;
    const attempts = prev?.clientMessageId === input.clientMessageId ? prev.attempts + 1 : 1;
    window.clearTimeout(prev?.timer);
    if (attempts > MAX_BUSY_RETRIES) {
      busyRetryRef.current = undefined;
      pendingPromptIdRef.current = undefined;
      lastPromptRef.current = undefined;
      setSubmissionOutcome({ clientMessageId: input.clientMessageId, status: "rejected" });
      busyRef.current = false;
      setBusy(false);
      clearBusyWatchdog();
      setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "上一轮任务长时间未结束，消息未发送，请稍后再试。" }]);
      return;
    }
    const timer = window.setTimeout(() => {
      if (pendingPromptIdRef.current !== input.clientMessageId) return;
      const threadId = activeChatThreadRef.current;
      if (!threadId) {
        scheduleBusyRetry(input);
        return;
      }
      // 本地 busy 可能仍为 true（上一轮 UI 状态）；仍尝试发送，服务端会再回 BUSY 或 ack
      if (!chatRef.current?.prompt(
        input.text,
        threadId,
        input.clientMessageId,
        input.attachmentIds,
        input.selectedArtifactIds ?? [],
      )) {
        scheduleBusyRetry(input);
        return;
      }
      // 已抛出；保持 draftLocked（pendingPromptId），busy 仅表示「在等本条被接受」
      busyRef.current = true;
      setBusy(true);
      armBusyWatchdog();
    }, BUSY_RETRY_MS);
    busyRetryRef.current = { clientMessageId: input.clientMessageId, attempts, timer };
  };

  const resetChatUi = useCallback(() => {
    setChatItems([]);
    setChatThreads([]);
    setActiveChatThreadId(undefined);
    activeChatThreadRef.current = undefined;
    setThreadChanging(false);
    setStreaming(undefined);
    streamBuf.current = "";
    processRef.current = null;
    busyRef.current = false;
    setBusy(false);
    clearBusyWatchdog();
    setSubmissionOutcome(undefined);
    pendingPromptIdRef.current = undefined;
    lastPromptRef.current = undefined;
    window.clearTimeout(busyRetryRef.current?.timer);
    busyRetryRef.current = undefined;
    threadLoadSequence.current += 1;
  }, [clearBusyWatchdog]);

  const closeChat = useCallback(() => {
    chatRef.current?.close();
    chatRef.current = undefined;
    setConnection("disconnected");
  }, []);

  /** 建/重建 WS，保留已加载消息。后端热重启 / HMR 后用 reconnectChat → 此函数。 */
  const openChatSocket = useCallback((projectId: string) => {
    chatRef.current?.close();
    chatRef.current = undefined;
    setConnection("connecting");

    const chat = connectChat(projectId, (event) => {
      if (activeProjectRef.current !== projectId) return;
      if (event.type === "agent_event") {
        const inner = event.event as AgentInnerEvent;
        if (inner.threadId && inner.threadId !== activeChatThreadRef.current) return;
        commitProcessResult(applyAgentInnerEvent(processRef.current, inner));
        return;
      }
      if (event.type === "chat_message") {
        if (event.message.threadId !== activeChatThreadRef.current) return;
        // job wake 等系统回注：协议 role=user 喂模型，UI 不展示、不抢线程标题
        if (isInternalSystemChatMessage(event.message)) return;
        if (event.message.role === "assistant") {
          streamBuf.current = "";
          setStreaming(undefined);
        }
        setChatItems((cur) => cur.some((item) => item.id === event.message.id)
          ? cur
          : [...cur, {
              id: event.message.id,
              role: event.message.role === "assistant" ? "agent" : "user",
              text: event.message.text,
              attachments: event.message.attachments,
            }]);
        if (event.message.role === "user") {
          const titleSource = event.message.text || event.message.attachments[0]?.originalFilename || "新对话";
          setChatThreads((current) => current.map((thread) => thread.id === event.message.threadId
            ? {
                ...thread,
                title: thread.title === "新对话" ? titleSource.replace(/\s+/g, " ").slice(0, 28) : thread.title,
                updatedAt: event.message.createdAt,
              }
            : thread));
        }
        return;
      }
      if (event.type === "prompt_ack") {
        if (event.threadId !== activeChatThreadRef.current) return;
        if (event.clientMessageId && pendingPromptIdRef.current === event.clientMessageId) {
          pendingPromptIdRef.current = undefined;
          lastPromptRef.current = undefined;
          window.clearTimeout(busyRetryRef.current?.timer);
          busyRetryRef.current = undefined;
          setSubmissionOutcome({ clientMessageId: event.clientMessageId, status: "acknowledged" });
        }
        return;
      }
      if (event.type === "agent_stopped") {
        if (event.threadId !== activeChatThreadRef.current) return;
        commitProcessResult(settleProcessStopped(processRef.current));
        return;
      }
      if (event.type === "project_renamed") {
        onProjectRenamedRef.current?.(projectId, event.name);
        return;
      }
      if (event.type === "object_changed") {
        // 先 refresh 再聚焦：否则 objects 里还没有新卡，Desk 聚焦 effect 会空转
        void refreshDesk(projectId)
          .then((snap) => {
            if (activeProjectRef.current !== projectId) return;
            onDeskObjectChangedRef.current?.(projectId, event.artifactId, snap);
            if (event.artifactId) setFocusFromAgent({ id: event.artifactId, token: Date.now() });
          })
          .catch((e) => {
            if (activeProjectRef.current !== projectId) return;
            setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `画布刷新失败：${e instanceof Error ? e.message : "未知错误"}` }]);
          });
        return;
      }
      if (event.type === "error") {
        // 后端上一轮还在跑：安静自动重试（输入经 externalId 幂等，重复发送安全）
        if (event.error.code === "ATTACHMENT_BUSY") {
          const pendingId = pendingPromptIdRef.current;
          const input = lastPromptRef.current;
          if (pendingId && input?.clientMessageId === pendingId
            && (!event.clientMessageId || event.clientMessageId === pendingId)) {
            scheduleBusyRetry(input);
            return;
          }
        }
        const pendingPromptId = pendingPromptIdRef.current;
        if (pendingPromptId && (!event.clientMessageId || event.clientMessageId === pendingPromptId)) {
          pendingPromptIdRef.current = undefined;
          lastPromptRef.current = undefined;
          window.clearTimeout(busyRetryRef.current?.timer);
          busyRetryRef.current = undefined;
          setSubmissionOutcome({ clientMessageId: pendingPromptId, status: "rejected" });
        }
        streamBuf.current = "";
        setStreaming(undefined);
        setChatItems((cur) => settleProcessError(cur, processRef.current, event.error.message).items);
        processRef.current = null;
        busyRef.current = false;
        setBusy(false);
        clearBusyWatchdog();
      }
    }, (status) => {
      if (status !== "connected" && pendingPromptIdRef.current) {
        const pendingPromptId = pendingPromptIdRef.current;
        pendingPromptIdRef.current = undefined;
        lastPromptRef.current = undefined;
        window.clearTimeout(busyRetryRef.current?.timer);
        busyRetryRef.current = undefined;
        setSubmissionOutcome({ clientMessageId: pendingPromptId, status: "rejected" });
        busyRef.current = false;
        setBusy(false);
        clearBusyWatchdog();
      }
      setConnection(status);
    });
    chatRef.current = chat;
  }, [activeProjectRef, armBusyWatchdog, clearBusyWatchdog, commitProcessResult, refreshDesk]);

  /** 打开项目：拉线程/历史 + 建 WS。项目可以没有任何对话，发首条消息时再建。 */
  const bindProjectChat = useCallback(async (projectId: string) => {
    closeChat();
    resetChatUi();
    setConnection("connecting");
    // bind generation：防止 A→B→A 时旧请求回写新会话
    const bindGen = ++threadLoadSequence.current;
    const threads = await api.chatThreads(projectId);
    if (activeProjectRef.current !== projectId || threadLoadSequence.current !== bindGen) return;
    setChatThreads(threads);
    const activeThread = threads[0];
    if (activeThread) {
      const history = await api.chatHistory(projectId, activeThread.id);
      if (activeProjectRef.current !== projectId || threadLoadSequence.current !== bindGen) return;
      setActiveChatThreadId(activeThread.id);
      activeChatThreadRef.current = activeThread.id;
      setChatItems(toVisibleChatItems(history.messages));
    }
    if (activeProjectRef.current !== projectId || threadLoadSequence.current !== bindGen) return;
    openChatSocket(projectId);
  }, [activeProjectRef, closeChat, openChatSocket, resetChatUi]);

  /** 仅重建 WS（不清消息）。用于后端重启 / HMR 后仍停在桌面时。 */
  const reconnectChat = useCallback((projectId: string) => {
    if (activeProjectRef.current !== projectId) return;
    openChatSocket(projectId);
  }, [activeProjectRef, openChatSocket]);

  /** 发 prompt；selectedArtifactIds 可选，由 ChatPanel 在有画布选中时填入。无活跃对话时先建线程再发。 */
  const sendChat = useCallback(
    (input: {
      text: string;
      attachmentIds: string[];
      clientMessageId: string;
      selectedArtifactIds?: string[];
    }) => {
      if (connection !== "connected" || busy) return false;
      lastPromptRef.current = input;
      const threadId = activeChatThreadRef.current;
      if (!threadId) {
        const projectId = activeProjectRef.current;
        if (!projectId) return false;
        // 先登记 pending，确保后续失败能通过 submissionOutcome 解锁 composer
        pendingPromptIdRef.current = input.clientMessageId;
        setSubmissionOutcome(undefined);
        busyRef.current = true;
        setBusy(true);
        armBusyWatchdog();
        void (async () => {
          try {
            const thread = await api.createChatThread(projectId);
            if (activeProjectRef.current !== projectId) {
              setSubmissionOutcome({ clientMessageId: input.clientMessageId, status: "rejected" });
              busyRef.current = false;
              setBusy(false);
              clearBusyWatchdog();
              return;
            }
            activeChatThreadRef.current = thread.id;
            setActiveChatThreadId(thread.id);
            setChatThreads((current) => [thread, ...current]);
            if (!chatRef.current?.prompt(
              input.text,
              thread.id,
              input.clientMessageId,
              input.attachmentIds,
              input.selectedArtifactIds ?? [],
            )) {
              setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "消息未发送，请等待连接恢复后重试。" }]);
              setSubmissionOutcome({ clientMessageId: input.clientMessageId, status: "rejected" });
              busyRef.current = false;
              setBusy(false);
              clearBusyWatchdog();
              return;
            }
          } catch (error) {
            setChatItems((current) => [...current, {
              id: nextId(),
              role: "agent",
              text: `新建对话失败：${error instanceof Error ? error.message : "未知错误"}`,
            }]);
            setSubmissionOutcome({ clientMessageId: input.clientMessageId, status: "rejected" });
            busyRef.current = false;
            setBusy(false);
            clearBusyWatchdog();
          }
        })();
        return true;
      }
      if (!chatRef.current?.prompt(
        input.text,
        threadId,
        input.clientMessageId,
        input.attachmentIds,
        input.selectedArtifactIds ?? [],
      )) {
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "消息未发送，请等待连接恢复后重试。" }]);
        return false;
      }
      pendingPromptIdRef.current = input.clientMessageId;
      setSubmissionOutcome(undefined);
      busyRef.current = true;
      setBusy(true);
      armBusyWatchdog();
      return true;
    },
    [busy, connection, activeProjectRef, armBusyWatchdog, clearBusyWatchdog],
  );

  const stopChat = useCallback(() => {
    const threadId = activeChatThreadRef.current;
    if (!busy || connection !== "connected" || !threadId) return;
    if (!chatRef.current?.stop(threadId)) {
      setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "停止指令未发送，请等待连接恢复后重试。" }]);
    }
  }, [busy, connection]);

  const selectChatThread = useCallback(async (threadId: string) => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || threadId === activeChatThreadRef.current || busy || threadChanging) return;
    const sequence = ++threadLoadSequence.current;
    setThreadChanging(true);
    try {
      const history = await api.chatHistory(currentProjectId, threadId);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      activeChatThreadRef.current = threadId;
      setActiveChatThreadId(threadId);
      streamBuf.current = "";
      processRef.current = null;
      setStreaming(undefined);
      setBusy(false);
      setChatItems(toVisibleChatItems(history.messages));
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `切换对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      if (threadLoadSequence.current === sequence) setThreadChanging(false);
    }
  }, [activeProjectRef, busy, threadChanging]);

  const createChatThread = useCallback(async () => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || busy || threadChanging) return;
    setThreadChanging(true);
    try {
      const thread = await api.createChatThread(currentProjectId);
      if (activeProjectRef.current !== currentProjectId) return;
      activeChatThreadRef.current = thread.id;
      setActiveChatThreadId(thread.id);
      setChatThreads((current) => [thread, ...current]);
      streamBuf.current = "";
      processRef.current = null;
      setStreaming(undefined);
      setBusy(false);
      setChatItems([]);
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `新建对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      setThreadChanging(false);
    }
  }, [activeProjectRef, busy, threadChanging]);

  const deleteChatThread = useCallback(async (threadId: string) => {
    const currentProjectId = activeProjectRef.current;
    if (!currentProjectId || busy || threadChanging) return;
    const sequence = ++threadLoadSequence.current;
    setThreadChanging(true);
    try {
      await api.deleteChatThread(currentProjectId, threadId);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      const remaining = chatThreadsRef.current.filter((thread) => thread.id !== threadId);
      setChatThreads(remaining);
      if (threadId !== activeChatThreadRef.current) return;

      const nextThread = remaining[0];
      streamBuf.current = "";
      processRef.current = null;
      setStreaming(undefined);
      setBusy(false);
      if (!nextThread) {
        // 删空了：允许零对话状态，等用户新建或发首条消息时再建
        activeChatThreadRef.current = undefined;
        setActiveChatThreadId(undefined);
        setChatItems([]);
        return;
      }
      const history = await api.chatHistory(currentProjectId, nextThread.id);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      activeChatThreadRef.current = nextThread.id;
      setActiveChatThreadId(nextThread.id);
      setChatItems(toVisibleChatItems(history.messages));
    } catch (error) {
      setChatItems((current) => [...current, {
        id: nextId(),
        role: "agent",
        text: `删除对话失败：${error instanceof Error ? error.message : "未知错误"}`,
      }]);
    } finally {
      if (threadLoadSequence.current === sequence) setThreadChanging(false);
    }
  }, [activeProjectRef, busy, threadChanging]);

  return {
    chatItems,
    setChatItems,
    chatThreads,
    activeChatThreadId,
    threadChanging,
    streaming,
    busy,
    setBusy,
    connection,
    setConnection,
    submissionOutcome,
    focusFromAgent,
    bindProjectChat,
    reconnectChat,
    closeChat,
    resetChatUi,
    sendChat,
    stopChat,
    selectChatThread,
    createChatThread,
    deleteChatThread,
  };
}
