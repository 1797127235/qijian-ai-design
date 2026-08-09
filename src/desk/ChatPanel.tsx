import { useEffect, useRef, useState, type CSSProperties } from "react";
import { History, LoaderCircle, MessageSquarePlus, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ChatConnectionStatus, ChatThread } from "../lib/api";
import { MAX_SELECTED_ARTIFACTS } from "../shared/selection-limits";
import type { ChatItem, DeskObject } from "./types";
import { useAttachmentDraft } from "./useAttachmentDraft";
import { useExitTransition } from "./useExitTransition";
import { ChatComposer, connectionLabels } from "./chat/ChatComposer";
import { ChatMessageList, MarkdownMessage } from "./chat/ChatMessageList";
import { ChatThreadList } from "./chat/ChatThreadList";

export { MarkdownMessage };

const DEFAULT_CHAT_WIDTH = 506;
const MIN_CHAT_WIDTH = 360;
const MAX_CHAT_WIDTH = 720;

/**
 * StrictMode 二次挂载：同一 handoff 只注入草稿一次；
 * autoSend 意图与 seed 选中放模块级，remount 后仍能发出。
 */
const appliedHandoffIds = new Set<string>();
const pendingAutoSendByHandoff = new Map<string, {
  text: string;
  seedSelectedIds: string[];
}>();

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
  handoffId,
  initialText,
  initialFiles,
  autoSend = false,
  seedSelectedArtifactIds,
  submissionOutcome,
  onSend,
  onStop,
  onNewThread,
  onSelectThread,
  onDeleteThread,
  onInitialFilesConsumed,
  onDraftStateChange,
  selectedObjects = [],
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
  handoffId?: string;
  initialText?: string;
  initialFiles?: File[];
  /** 首页创建进入桌面：自动展开助手并发出首条任务 */
  autoSend?: boolean;
  /** 落桌图 id（桌面 snapshot 尚未映射前也能随首条消息带上选中） */
  seedSelectedArtifactIds?: string[];
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
  selectedObjects?: DeskObject[];
  /** 传 id 移除单项；不传清空全部 */
  onClearSelection?: (id?: string) => void;
}) {
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("qijian.chat.collapsed") === "true");
  const [panelWidth, setPanelWidth] = useState(storedChatWidth);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMenu = useExitTransition(historyOpen ? true : undefined, 120);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const panelWidthRef = useRef(panelWidth);
  const resizing = useRef<{ startX: number; startWidth: number }>();
  const submittedRef = useRef<{ clientMessageId: string; text: string; localIds: string[] }>();
  const seedSelectedRef = useRef<string[]>([]);
  const activeHandoffIdRef = useRef<string>();
  const [pendingClientMessageId, setPendingClientMessageId] = useState<string>();
  const [autoSendArmed, setAutoSendArmed] = useState(false);
  const attachments = useAttachmentDraft(projectId);
  const draftLocked = Boolean(pendingClientMessageId);
  const attachmentsReady = attachments.items.every((item) => item.status === "uploaded");
  const hasContent = Boolean(input.trim()) || attachments.items.some((item) => item.status === "uploaded");
  const sendDisabled = busy || draftLocked || connection !== "connected" || !attachmentsReady;

  // 首页 handoff：草稿注入去重；autoSend 状态进模块 Map，remount 后恢复 armed。
  useEffect(() => {
    if (!handoffId) return;
    activeHandoffIdRef.current = handoffId;
    const pending = pendingAutoSendByHandoff.get(handoffId);
    if (pending) {
      setInput((cur) => cur || pending.text);
      seedSelectedRef.current = pending.seedSelectedIds;
      setCollapsed(false);
      setAutoSendArmed(true);
    }
    if (appliedHandoffIds.has(handoffId)) return;
    if (!initialText && !initialFiles?.length && !autoSend && !seedSelectedArtifactIds?.length) return;
    appliedHandoffIds.add(handoffId);
    const text = initialText ?? "";
    const seeds = seedSelectedArtifactIds?.length ? [...seedSelectedArtifactIds] : [];
    if (text) setInput(text);
    if (initialFiles?.length) attachments.addFiles(initialFiles);
    if (seeds.length) seedSelectedRef.current = seeds;
    if (autoSend) {
      pendingAutoSendByHandoff.set(handoffId, { text, seedSelectedIds: seeds });
      setCollapsed(false);
      setAutoSendArmed(true);
      return;
    }
    onInitialFilesConsumed?.();
  }, [handoffId, initialText, initialFiles, autoSend, seedSelectedArtifactIds, attachments.addFiles, onInitialFilesConsumed]);

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
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (historyMenuRef.current?.contains(target)) return;
      if (historyButtonRef.current?.contains(target)) return;
      setHistoryOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [historyOpen]);

  // 对话删空后收起历史菜单，避免只剩个空壳标题
  useEffect(() => {
    if (threads.length === 0) setHistoryOpen(false);
  }, [threads.length]);

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
    // 选中：桌面 chip 优先；首页 handoff 的落桌图 id 作 seed（snapshot 尚未映射时仍能指认）
    const fromUi = selectedObjects.map((o) => o.id);
    const fromSeed = seedSelectedRef.current;
    const selectedArtifactIds = (fromUi.length > 0 ? fromUi : fromSeed).slice(0, MAX_SELECTED_ARTIFACTS);
    if (!onSend({
      text,
      attachmentIds: ready.map((item) => item.stored!.id),
      clientMessageId,
      ...(selectedArtifactIds.length > 0 ? { selectedArtifactIds } : {}),
    })) return;
    const hid = activeHandoffIdRef.current;
    if (hid && pendingAutoSendByHandoff.has(hid)) {
      pendingAutoSendByHandoff.delete(hid);
      setAutoSendArmed(false);
      seedSelectedRef.current = [];
      onInitialFilesConsumed?.();
    }
    submittedRef.current = { clientMessageId, text, localIds };
    setPendingClientMessageId(clientMessageId);
    stickToBottom.current = true;
  };

  // 首页创建 handoff：连接就绪且草稿齐后自动发出首条任务
  useEffect(() => {
    if (!autoSendArmed) return;
    const hid = activeHandoffIdRef.current;
    if (!hid || !pendingAutoSendByHandoff.has(hid)) return;
    if (sendDisabled) return;
    if (!input.trim() && !attachments.items.some((item) => item.status === "uploaded")) return;
    if (attachments.items.some((item) => item.status === "queued" || item.status === "uploading" || item.status === "error")) return;
    submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readiness-driven; submit closes over latest onSend/selection
  }, [autoSendArmed, sendDisabled, input, attachments.items, connection, busy]);

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
              <span className="chat-title" title={activeThread?.title}>{activeThread?.title ?? "设计助手"}</span>
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
                ref={historyButtonRef}
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
                <PanelRightClose size={18} strokeWidth={1.7} />
              </button>
            </div>
            {historyMenu.rendered && (
              <ChatThreadList
                ref={historyMenuRef}
                closing={historyMenu.closing}
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
            selectedObjects={selectedObjects}
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
