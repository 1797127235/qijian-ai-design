import { useEffect, useRef, useState, type CSSProperties } from "react";
import { History, LoaderCircle, MessageSquarePlus, PanelRightOpen, X } from "lucide-react";
import type { ChatConnectionStatus, ChatThread } from "../lib/api";
import type { ChatItem, DeskObject } from "./types";
import { useAttachmentDraft } from "./useAttachmentDraft";
import { ChatComposer, connectionLabels } from "./chat/ChatComposer";
import { ChatMessageList, MarkdownMessage } from "./chat/ChatMessageList";
import { ChatThreadList } from "./chat/ChatThreadList";

export { MarkdownMessage };

const DEFAULT_CHAT_WIDTH = 506;
const MIN_CHAT_WIDTH = 360;
const MAX_CHAT_WIDTH = 720;

function storedChatWidth() {
  const stored = window.localStorage.getItem("qijian.chat.width");
  if (stored === null) return DEFAULT_CHAT_WIDTH;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, value)) : DEFAULT_CHAT_WIDTH;
}

function availableChatWidth() {
  const reserved = window.innerWidth <= 900 ? 44 : 320;
  return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, window.innerWidth - reserved));
}

function clampChatWidth(width: number) {
  return Math.round(Math.min(availableChatWidth(), Math.max(MIN_CHAT_WIDTH, width)));
}

export function ChatPanel({
  projectId,
  items,
  streaming,
  busy,
  connection,
  threads,
  activeThreadId,
  threadChanging,
  initialText,
  initialFiles,
  submissionOutcome,
  onSend,
  onStop,
  onNewThread,
  onSelectThread,
  onDeleteThread,
  onInitialFilesConsumed,
  onDraftStateChange,
  selectedObject,
  onClearSelection,
}: {
  projectId: string;
  items: ChatItem[];
  streaming?: string;
  busy: boolean;
  connection: ChatConnectionStatus;
  threads: ChatThread[];
  activeThreadId?: string;
  threadChanging: boolean;
  initialText?: string;
  initialFiles?: File[];
  submissionOutcome?: { clientMessageId: string; status: "acknowledged" | "rejected" };
  onSend: (input: {
    text: string;
    attachmentIds: string[];
    clientMessageId: string;
    selectedArtifactIds?: string[];
  }) => boolean;
  onStop: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onInitialFilesConsumed?: () => void;
  onDraftStateChange?: (hasDraft: boolean) => void;
  /** 画布当前选中；有则 composer 立刻显示 chip，发送时写入 selectedArtifactIds */
  selectedObject?: DeskObject;
  onClearSelection?: () => void;
}) {
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("qijian.chat.collapsed") === "true");
  const [panelWidth, setPanelWidth] = useState(storedChatWidth);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const panelWidthRef = useRef(panelWidth);
  const resizing = useRef<{ startX: number; startWidth: number }>();
  const submittedRef = useRef<{ clientMessageId: string; text: string; localIds: string[] }>();
  const [pendingClientMessageId, setPendingClientMessageId] = useState<string>();
  const attachments = useAttachmentDraft(projectId);
  const draftLocked = Boolean(pendingClientMessageId);
  const attachmentsReady = attachments.items.every((item) => item.status === "uploaded");
  const hasContent = Boolean(input.trim()) || attachments.items.some((item) => item.status === "uploaded");
  const sendDisabled = busy || draftLocked || connection !== "connected" || !attachmentsReady;

  useEffect(() => {
    if (!initialText && !initialFiles?.length) return;
    if (initialText) setInput(initialText);
    if (initialFiles?.length) attachments.addFiles(initialFiles);
    onInitialFilesConsumed?.();
  }, [initialText, initialFiles, attachments.addFiles, onInitialFilesConsumed]);

  useEffect(() => onDraftStateChange?.(attachments.items.length > 0), [attachments.items.length, onDraftStateChange]);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (!submissionOutcome || !submitted || submissionOutcome.clientMessageId !== submitted.clientMessageId) return;
    setPendingClientMessageId(undefined);
    if (submissionOutcome.status === "rejected") return;
    submittedRef.current = undefined;
    setInput("");
    attachments.clearClaimed(submitted.localIds);
  }, [submissionOutcome, attachments.clearClaimed]);

  useEffect(() => {
    const last = items.at(-1);
    if (last?.role === "user") stickToBottom.current = true;
    if (stickToBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items, streaming, busy]);

  useEffect(() => {
    window.localStorage.setItem("qijian.chat.collapsed", String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    const clampOnResize = () => setPanelWidth((current) => {
      const next = clampChatWidth(current);
      panelWidthRef.current = next;
      return next;
    });
    window.addEventListener("resize", clampOnResize);
    return () => window.removeEventListener("resize", clampOnResize);
  }, []);

  useEffect(() => () => document.body.classList.remove("chat-is-resizing"), []);

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  const submit = () => {
    const text = input.trim();
    const ready = attachments.items.filter((item) => item.status === "uploaded" && item.stored);
    if ((!text && ready.length === 0) || sendDisabled) return;
    const localIds = ready.map((item) => item.localId);
    const retry = submittedRef.current;
    const clientMessageId = retry
      && retry.text === text
      && retry.localIds.length === localIds.length
      && retry.localIds.every((id, index) => id === localIds[index])
      ? retry.clientMessageId
      : globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // 选中只在发送时带给后端；chip 本身是纯前端即时反馈
    if (!onSend({
      text,
      attachmentIds: ready.map((item) => item.stored!.id),
      clientMessageId,
      ...(selectedObject ? { selectedArtifactIds: [selectedObject.id] } : {}),
    })) return;
    submittedRef.current = { clientMessageId, text, localIds };
    setPendingClientMessageId(clientMessageId);
    stickToBottom.current = true;
  };

  const discardDraftBefore = (action: () => void) => {
    if (attachments.items.length > 0 && !window.confirm("当前消息还有未发送的附件。离开后将丢弃这些附件，是否继续？")) return;
    attachments.discardAll();
    action();
  };

  const activeThread = threads.find((thread) => thread.id === activeThreadId);

  const setAndStorePanelWidth = (width: number) => {
    const next = clampChatWidth(width);
    panelWidthRef.current = next;
    setPanelWidth(next);
    window.localStorage.setItem("qijian.chat.width", String(next));
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 720) return;
    event.preventDefault();
    resizing.current = { startX: event.clientX, startWidth: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("chat-is-resizing");
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing.current) return;
    const next = clampChatWidth(resizing.current.startWidth + resizing.current.startX - event.clientX);
    panelWidthRef.current = next;
    setPanelWidth(next);
  };

  const endResize = () => {
    if (!resizing.current) return;
    resizing.current = undefined;
    window.localStorage.setItem("qijian.chat.width", String(panelWidthRef.current));
    document.body.classList.remove("chat-is-resizing");
  };

  return (
    <aside
      className={`chat ${collapsed ? "chat-collapsed" : ""}`}
      style={{ "--chat-width": `${panelWidth}px` } as CSSProperties}
    >
      {collapsed ? (
        <button
          type="button"
          className="chat-collapsed-toggle"
          aria-label="展开设计助手"
          title="展开设计助手"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <PanelRightOpen size={18} strokeWidth={1.8} />
        </button>
      ) : (
        <>
          <div
            className="chat-resize-handle"
            role="separator"
            tabIndex={0}
            aria-label="调整设计助手宽度"
            aria-orientation="vertical"
            aria-valuemin={MIN_CHAT_WIDTH}
            aria-valuemax={availableChatWidth()}
            aria-valuenow={panelWidth}
            title="拖动调整宽度，双击恢复默认"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={() => setAndStorePanelWidth(DEFAULT_CHAT_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setAndStorePanelWidth(panelWidth + 16);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setAndStorePanelWidth(panelWidth - 16);
              } else if (event.key === "Home") {
                event.preventDefault();
                setAndStorePanelWidth(DEFAULT_CHAT_WIDTH);
              }
            }}
          />
          <div className="chat-head">
            <div className="chat-head-copy">
              <span className="chat-title" title={activeThread?.title}>{activeThread?.title ?? "新对话"}</span>
              <span className="chat-beta">Beta</span>
              <span className={`chat-connection ${connection}`}>{connectionLabels[connection]}</span>
            </div>
            <div className="chat-head-actions">
              <button
                type="button"
                className="chat-icon-button"
                disabled={busy || threadChanging}
                aria-label="新建对话"
                title={busy ? "请等待当前任务完成" : "新建对话"}
                onClick={() => {
                  discardDraftBefore(() => {
                    setHistoryOpen(false);
                    onNewThread();
                  });
                }}
              >
                {threadChanging ? <LoaderCircle className="is-spinning" size={17} /> : <MessageSquarePlus size={17} strokeWidth={1.7} />}
              </button>
              <button
                type="button"
                className="chat-icon-button"
                disabled={threads.length === 0}
                aria-label="对话历史"
                title="对话历史"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <History size={17} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="chat-icon-button"
                aria-label="折叠设计助手"
                title="折叠设计助手"
                aria-expanded={true}
                onClick={() => setCollapsed(true)}
              >
                <X size={18} strokeWidth={1.7} />
              </button>
            </div>
            {historyOpen && (
              <ChatThreadList
                threads={threads}
                activeThreadId={activeThreadId}
                threadChanging={threadChanging}
                busy={busy}
                onSelect={(threadId) => {
                  discardDraftBefore(() => {
                    setHistoryOpen(false);
                    onSelectThread(threadId);
                  });
                }}
                onDelete={(threadId) => onDeleteThread(threadId)}
              />
            )}
          </div>
          <ChatMessageList
            items={items}
            streaming={streaming}
            busy={busy}
            sendDisabled={sendDisabled}
            listRef={listRef}
            stickToBottom={stickToBottom}
            onPickSuggestion={(title) => {
              setInput(title);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
          <ChatComposer
            input={input}
            setInput={setInput}
            draftLocked={draftLocked}
            connection={connection}
            busy={busy}
            hasContent={hasContent}
            attachmentsReady={attachmentsReady}
            items={attachments.items}
            selectedObject={selectedObject}
            onClearSelection={onClearSelection}
            fileInputRef={fileInputRef}
            inputRef={inputRef}
            onSubmit={submit}
            onStop={onStop}
            onAddFiles={attachments.addFiles}
            onRetry={attachments.retry}
            onRemove={attachments.remove}
          />
        </>
      )}
    </aside>
  );
}
