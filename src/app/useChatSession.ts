import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { api, connectChat, type ChatConnectionStatus, type ChatThread, type DeskSnapshot } from "../lib/api";
import type { ChatItem, ProcessSnapshot, ProcessStep } from "../desk/types";
import {
  emptyProcess,
  isToolBusinessFailure,
  toolStepLabel,
} from "../desk/chat/process-summary";
import { nextId } from "./ids";

const PROCESS_ITEM_ID = "agent-process-live";

function upsertProcessItem(items: ChatItem[], process: ProcessSnapshot): ChatItem[] {
  const next: ChatItem = { id: PROCESS_ITEM_ID, role: "process", process };
  const without = items.filter((it) => it.id !== PROCESS_ITEM_ID);
  return [...without, next];
}

function finalizeProcessItem(items: ChatItem[], process: ProcessSnapshot): ChatItem[] {
  const finalized: ChatItem = {
    id: `process-${nextId()}`,
    role: "process",
    process: { ...process, steps: process.steps.map((s) => ({ ...s })) },
  };
  return [...items.filter((it) => it.id !== PROCESS_ITEM_ID), finalized];
}

export function useChatSession(options: {
  activeProjectRef: MutableRefObject<string | undefined>;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
}) {
  const { activeProjectRef, refreshDesk } = options;
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

  const pushProcess = useCallback((mutator: (draft: ProcessSnapshot) => void) => {
    const draft = processRef.current ?? emptyProcess();
    // 兜底：避免 startedAt 丢失导致「思考了 NaNs」
    if (!Number.isFinite(draft.startedAt)) draft.startedAt = Date.now();
    mutator(draft);
    processRef.current = draft;
    setChatItems((cur) => upsertProcessItem(cur, {
      ...draft,
      steps: draft.steps.map((s) => ({ ...s })),
    }));
  }, []);

  const MAX_BUSY_RETRIES = 15;

  /** 上一轮仍在执行时的安静重试：每 1.5s 看一次，忙则继续等，封顶后放弃 */
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
      setBusy(false);
      setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: "上一轮任务长时间未结束，消息未发送，请稍后再试。" }]);
      return;
    }
    const timer = window.setTimeout(() => {
      // 用户已切项目/线程，或该消息已被其他路径了结
      if (pendingPromptIdRef.current !== input.clientMessageId) return;
      if (busyRef.current) {
        scheduleBusyRetry(input);
        return;
      }
      const threadId = activeChatThreadRef.current;
      if (!threadId || !chatRef.current?.prompt(
        input.text,
        threadId,
        input.clientMessageId,
        input.attachmentIds,
        input.selectedArtifactIds ?? [],
      )) {
        scheduleBusyRetry(input);
        return;
      }
      setBusy(true);
    }, 1500);
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
    setBusy(false);
    setSubmissionOutcome(undefined);
    pendingPromptIdRef.current = undefined;
    lastPromptRef.current = undefined;
    window.clearTimeout(busyRetryRef.current?.timer);
    busyRetryRef.current = undefined;
    threadLoadSequence.current += 1;
  }, []);

  const closeChat = useCallback(() => {
    chatRef.current?.close();
    chatRef.current = undefined;
    setConnection("disconnected");
  }, []);

  /** 只建/重建 WS，不清聊天记录。热更新或后端重启后用它恢复。 */
  const openChatSocket = useCallback((projectId: string) => {
    chatRef.current?.close();
    chatRef.current = undefined;
    setConnection("connecting");

    const chat = connectChat(projectId, (event) => {
      if (activeProjectRef.current !== projectId) return;
      if (event.type === "agent_event") {
        const inner = event.event as {
          type?: string;
          threadId?: string;
          toolName?: string;
          toolCallId?: string;
          args?: unknown;
          result?: unknown;
          isError?: boolean;
          assistantMessageEvent?: { type?: string; delta?: string };
        };
        if (inner.threadId && inner.threadId !== activeChatThreadRef.current) return;

        if (inner.type === "message_update" && inner.assistantMessageEvent) {
          const ame = inner.assistantMessageEvent;
          if (ame.type === "text_delta" && ame.delta) {
            streamBuf.current += ame.delta;
            setStreaming(streamBuf.current);
          }
          if (ame.type === "thinking_delta" && ame.delta) {
            const delta = ame.delta;
            pushProcess((draft) => {
              draft.status = "running";
              const last = draft.steps[draft.steps.length - 1];
              if (last?.kind === "thinking") last.text += delta;
              else draft.steps.push({ id: nextId(), kind: "thinking", text: delta });
            });
          }
        }

        if (inner.type === "agent_start") {
          processRef.current = emptyProcess();
          setBusy(true);
          setChatItems((cur) => upsertProcessItem(cur, processRef.current!));
        }

        if (inner.type === "agent_settled") {
          const snap = processRef.current;
          if (snap) {
            const failed = snap.steps.some((s) => s.kind === "tool" && s.status === "failed");
            snap.status = failed ? "failed" : "done";
            snap.endedAt = Date.now();
            setChatItems((cur) => finalizeProcessItem(cur, snap));
          }
          processRef.current = null;
          setBusy(false);
        }

        if (inner.type === "tool_execution_start" && inner.toolName) {
          const toolCallId = inner.toolCallId ?? `${inner.toolName}-${Date.now()}`;
          const step: ProcessStep = {
            id: toolCallId,
            kind: "tool",
            name: inner.toolName,
            status: "running",
            label: toolStepLabel(inner.args, undefined, false),
          };
          pushProcess((draft) => {
            draft.status = "running";
            const idx = draft.steps.findIndex((s) => s.id === toolCallId);
            if (idx >= 0) draft.steps[idx] = step;
            else draft.steps.push(step);
          });
        }

        if (inner.type === "tool_execution_end") {
          const toolCallId = inner.toolCallId;
          // fail() 返回正常 content，pi 的 isError 常为 false，需识别业务失败
          const failed = isToolBusinessFailure(inner.result, inner.isError);
          pushProcess((draft) => {
            // 整轮 status 保持 running，直到 agent_settled；否则标题会变成「思考了 Ns」却仍在回复
            draft.status = "running";
            const tools = draft.steps.filter((s): s is Extract<ProcessStep, { kind: "tool" }> => s.kind === "tool");
            const step = toolCallId
              ? tools.find((t) => t.id === toolCallId)
              : tools.find((t) => t.status === "running");
            const label = toolStepLabel(undefined, inner.result, failed);
            if (!step) {
              draft.steps.push({
                id: toolCallId ?? `tool-end-${Date.now()}`,
                kind: "tool",
                name: inner.toolName ?? "tool",
                status: failed ? "failed" : "succeeded",
                label,
              });
            } else {
              step.status = failed ? "failed" : "succeeded";
              if (label) step.label = label;
            }
          });
        }
        return;
      }
      if (event.type === "chat_message") {
        if (event.message.threadId !== activeChatThreadRef.current) return;
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
        const snap = processRef.current;
        if (snap) {
          snap.status = "failed";
          snap.endedAt = Date.now();
          for (const t of snap.steps) {
            if (t.kind === "tool" && t.status === "running") {
              t.status = "failed";
              t.label = t.label ?? "已停止";
            }
          }
          setChatItems((cur) => finalizeProcessItem(cur, snap));
        }
        processRef.current = null;
        setBusy(false);
        return;
      }
      if (event.type === "object_changed") {
        if (event.artifactId) setFocusFromAgent({ id: event.artifactId, token: Date.now() });
        void refreshDesk(projectId).catch((e) => {
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
        const snap = processRef.current;
        if (snap) {
          snap.status = "failed";
          setChatItems((cur) => [
            ...finalizeProcessItem(cur, snap),
            { id: nextId(), role: "agent", text: `出错了：${event.error.message}` },
          ]);
        } else {
          setChatItems((cur) => [
            ...cur.filter((item) => item.id !== PROCESS_ITEM_ID),
            { id: nextId(), role: "agent", text: `出错了：${event.error.message}` },
          ]);
        }
        processRef.current = null;
        setBusy(false);
      }
    }, (status) => {
      if (status !== "connected" && pendingPromptIdRef.current) {
        const pendingPromptId = pendingPromptIdRef.current;
        pendingPromptIdRef.current = undefined;
        lastPromptRef.current = undefined;
        window.clearTimeout(busyRetryRef.current?.timer);
        busyRetryRef.current = undefined;
        setSubmissionOutcome({ clientMessageId: pendingPromptId, status: "rejected" });
        setBusy(false);
      }
      setConnection(status);
    });
    chatRef.current = chat;
  }, [activeProjectRef, pushProcess, refreshDesk]);

  /** 打开项目：拉线程/历史 + 建 WS。项目可以没有任何对话，发首条消息时再建。 */
  const bindProjectChat = useCallback(async (projectId: string) => {
    closeChat();
    resetChatUi();
    setConnection("connecting");
    const threads = await api.chatThreads(projectId);
    if (activeProjectRef.current !== projectId) return;
    setChatThreads(threads);
    const activeThread = threads[0];
    if (activeThread) {
      const history = await api.chatHistory(projectId, activeThread.id);
      if (activeProjectRef.current !== projectId) return;
      setActiveChatThreadId(activeThread.id);
      activeChatThreadRef.current = activeThread.id;
      setChatItems(history.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : "user",
        text: message.text,
        attachments: message.attachments,
      })));
    }
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
        setBusy(true);
        void (async () => {
          try {
            const thread = await api.createChatThread(projectId);
            if (activeProjectRef.current !== projectId) return;
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
              setBusy(false);
              return;
            }
            pendingPromptIdRef.current = input.clientMessageId;
            setSubmissionOutcome(undefined);
          } catch (error) {
            setChatItems((current) => [...current, {
              id: nextId(),
              role: "agent",
              text: `新建对话失败：${error instanceof Error ? error.message : "未知错误"}`,
            }]);
            setBusy(false);
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
      setBusy(true);
      return true;
    },
    [busy, connection, activeProjectRef],
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
      setChatItems(history.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : "user",
        text: message.text,
        attachments: message.attachments,
      })));
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
      setChatItems(history.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : "user",
        text: message.text,
        attachments: message.attachments,
      })));
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
