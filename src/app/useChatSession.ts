import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { api, connectChat, type ChatConnectionStatus, type ChatThread, type DeskSnapshot } from "../lib/api";
import type { ChatItem } from "../desk/types";
import { nextId } from "./ids";

const toolActivityLabel = (toolName: string) => toolName;

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
  const [connection, setConnection] = useState<ChatConnectionStatus>("disconnected");
  const [submissionOutcome, setSubmissionOutcome] = useState<{
    clientMessageId: string;
    status: "acknowledged" | "rejected";
  }>();
  const [focusFromAgent, setFocusFromAgent] = useState<{ id: string; token: number }>();

  const chatRef = useRef<ReturnType<typeof connectChat>>();
  const streamBuf = useRef("");
  const activeChatThreadRef = useRef<string>();
  const activeToolsRef = useRef(new Map<string, string>());
  const threadLoadSequence = useRef(0);
  const pendingPromptIdRef = useRef<string>();
  const chatThreadsRef = useRef<ChatThread[]>([]);
  // 每次 chatThreads 变化同步到 ref，让回调可以从 ref 读取最新值，无需把它放进 deps
  chatThreadsRef.current = chatThreads;

  const resetChatUi = useCallback(() => {
    setChatItems([]);
    setChatThreads([]);
    setActiveChatThreadId(undefined);
    activeChatThreadRef.current = undefined;
    setThreadChanging(false);
    setStreaming(undefined);
    streamBuf.current = "";
    activeToolsRef.current.clear();
    setBusy(false);
    setSubmissionOutcome(undefined);
    pendingPromptIdRef.current = undefined;
    threadLoadSequence.current += 1;
  }, []);

  const closeChat = useCallback(() => {
    chatRef.current?.close();
    chatRef.current = undefined;
    setConnection("disconnected");
  }, []);

  const bindProjectChat = useCallback(async (projectId: string) => {
    closeChat();
    resetChatUi();
    setConnection("connecting");
    const threads = await api.chatThreads(projectId);
    if (activeProjectRef.current !== projectId) return;
    const activeThread = threads[0];
    if (!activeThread) throw new Error("项目没有可用的对话线程");
    const history = await api.chatHistory(projectId, activeThread.id);
    if (activeProjectRef.current !== projectId) return;
    setChatThreads(threads);
    setActiveChatThreadId(activeThread.id);
    activeChatThreadRef.current = activeThread.id;
    setChatItems(history.messages.map((message) => ({
      id: message.id,
      role: message.role === "assistant" ? "agent" : "user",
      text: message.text,
      attachments: message.attachments,
    })));

    const chat = connectChat(projectId, (event) => {
      if (activeProjectRef.current !== projectId) return;
      if (event.type === "agent_event") {
        const inner = event.event;
        if (inner.threadId && inner.threadId !== activeChatThreadRef.current) return;
        if (inner.type === "message_update" && inner.assistantMessageEvent?.type === "text_delta" && inner.assistantMessageEvent.delta) {
          streamBuf.current += inner.assistantMessageEvent.delta;
          setStreaming(streamBuf.current);
        }
        if (inner.type === "agent_start") setBusy(true);
        if (inner.type === "agent_settled") {
          activeToolsRef.current.clear();
          setChatItems((cur) => cur.filter((it) => it.role !== "activity"));
          setBusy(false);
        }
        if (inner.type === "tool_execution_start" && inner.toolName) {
          const toolCallId = inner.toolCallId ?? `${inner.toolName}-${activeToolsRef.current.size}`;
          activeToolsRef.current.set(toolCallId, toolActivityLabel(inner.toolName));
          setChatItems((cur) => [
            ...cur.filter((it) => it.role !== "activity"),
            { id: "active-tools", role: "activity", text: `正在执行：${[...activeToolsRef.current.values()].join("、")}` },
          ]);
        }
        if (inner.type === "tool_execution_end") {
          if (inner.toolCallId) activeToolsRef.current.delete(inner.toolCallId);
          else activeToolsRef.current.clear();
          setChatItems((cur) => activeToolsRef.current.size === 0
            ? cur.filter((it) => it.role !== "activity")
            : [
                ...cur.filter((it) => it.role !== "activity"),
                { id: "active-tools", role: "activity", text: `正在执行：${[...activeToolsRef.current.values()].join("、")}` },
              ]);
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
          setSubmissionOutcome({ clientMessageId: event.clientMessageId, status: "acknowledged" });
        }
        return;
      }
      if (event.type === "agent_stopped") {
        if (event.threadId !== activeChatThreadRef.current) return;
        activeToolsRef.current.clear();
        setChatItems((cur) => cur.filter((it) => it.role !== "activity"));
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
        const pendingPromptId = pendingPromptIdRef.current;
        if (pendingPromptId && (!event.clientMessageId || event.clientMessageId === pendingPromptId)) {
          pendingPromptIdRef.current = undefined;
          setSubmissionOutcome({ clientMessageId: pendingPromptId, status: "rejected" });
        }
        activeToolsRef.current.clear();
        streamBuf.current = "";
        setStreaming(undefined);
        setChatItems((cur) => [
          ...cur.filter((item) => item.role !== "activity"),
          { id: nextId(), role: "agent", text: `出错了：${event.error.message}` },
        ]);
        setBusy(false);
      }
    }, (status) => {
      if (status !== "connected" && pendingPromptIdRef.current) {
        const pendingPromptId = pendingPromptIdRef.current;
        pendingPromptIdRef.current = undefined;
        setSubmissionOutcome({ clientMessageId: pendingPromptId, status: "rejected" });
        setBusy(false);
      }
      setConnection(status);
    });
    chatRef.current = chat;
  }, [activeProjectRef, closeChat, refreshDesk, resetChatUi]);

  /** 发 prompt；selectedArtifactIds 可选，由 ChatPanel 在有画布选中时填入。 */
  const sendChat = useCallback(
    (input: {
      text: string;
      attachmentIds: string[];
      clientMessageId: string;
      selectedArtifactIds?: string[];
    }) => {
      const threadId = activeChatThreadRef.current;
      if (connection !== "connected" || busy || !threadId) return false;
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
    [busy, connection],
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
      setStreaming(undefined);
      activeToolsRef.current.clear();
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
      setStreaming(undefined);
      activeToolsRef.current.clear();
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

      let nextThread = remaining[0];
      if (!nextThread) {
        nextThread = await api.createChatThread(currentProjectId);
        setChatThreads([nextThread]);
      }
      const history = await api.chatHistory(currentProjectId, nextThread.id);
      if (activeProjectRef.current !== currentProjectId || threadLoadSequence.current !== sequence) return;
      activeChatThreadRef.current = nextThread.id;
      setActiveChatThreadId(nextThread.id);
      streamBuf.current = "";
      setStreaming(undefined);
      activeToolsRef.current.clear();
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
    closeChat,
    resetChatUi,
    sendChat,
    stopChat,
    selectChatThread,
    createChatThread,
    deleteChatThread,
  };
}
