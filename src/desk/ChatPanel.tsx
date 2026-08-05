import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUp, History, LoaderCircle, MessageSquarePlus, PanelRightOpen, Plus, Square, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatConnectionStatus, ChatThread } from "../lib/api";
import { safeMarkdownUrl } from "./markdown";
import type { ChatItem } from "./types";

const connectionLabels: Record<ChatConnectionStatus, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "正在重连",
  disconnected: "已离线",
};

const suggestions = [
  { title: "整理项目理解", description: "读取当前画布与户型图，提炼空间问题和设计机会" },
  { title: "出三个设计方向", description: "基于当前约束，形成三个真正可比较的方案方向" },
  { title: "给客厅出效果图", description: "结合已确认方向，为重点空间生成视觉方案" },
];

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

function PlainMessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return <>{parts.map((part, index) => part.startsWith("http://") || part.startsWith("https://")
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">{part}</a>
    : part)}</>;
}

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ChatPanel({
  items,
  streaming,
  busy,
  connection,
  threads,
  activeThreadId,
  threadChanging,
  onSend,
  onStop,
  onNewThread,
  onSelectThread,
  onDeleteThread,
}: {
  items: ChatItem[];
  streaming?: string;
  busy: boolean;
  connection: ChatConnectionStatus;
  threads: ChatThread[];
  activeThreadId?: string;
  threadChanging: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
}) {
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("qijian.chat.collapsed") === "true");
  const [panelWidth, setPanelWidth] = useState(storedChatWidth);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const panelWidthRef = useRef(panelWidth);
  const resizing = useRef<{ startX: number; startWidth: number }>();
  const sendDisabled = busy || connection !== "connected";

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
    if (!text || sendDisabled) return;
    setInput("");
    stickToBottom.current = true;
    onSend(text);
  };

  const insertPrompt = (text: string) => {
    setInput((current) => current.trim() ? `${current.trimEnd()} ${text}` : text);
    requestAnimationFrame(() => inputRef.current?.focus());
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
              setHistoryOpen(false);
              onNewThread();
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
          <div className="chat-thread-menu" role="dialog" aria-label="对话历史">
            <span className="chat-thread-menu-title">对话历史</span>
            <div className="chat-thread-list">
              {threads.map((thread) => (
                <div key={thread.id} className={`chat-thread-row ${thread.id === activeThreadId ? "active" : ""}`}>
                  <button
                    type="button"
                    className="chat-thread-select"
                    disabled={threadChanging || busy}
                    onClick={() => {
                      setHistoryOpen(false);
                      onSelectThread(thread.id);
                    }}
                  >
                    <strong>{thread.title}</strong>
                    <span>{new Date(thread.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-thread-delete"
                    disabled={threadChanging || busy}
                    aria-label={`删除对话：${thread.title}`}
                    title="删除对话"
                    onClick={() => {
                      if (window.confirm(`确定删除“${thread.title}”吗？删除后无法恢复。`)) onDeleteThread(thread.id);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.7} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div
        className="chat-list"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {items.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="chat-empty-intro">
              <span>砌间设计助手</span>
              <h2>想从哪一步开始？</h2>
              <p>我会读取当前画布，再和你一起推进方案。</p>
            </div>
            <div className="chat-suggestions">
              {suggestions.map((suggestion) => (
                <button key={suggestion.title} type="button" disabled={sendDisabled} onClick={() => onSend(suggestion.title)}>
                  <strong>{suggestion.title}</strong>
                  <span>{suggestion.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "agent" ? <MarkdownMessage text={m.text} /> : <PlainMessageText text={m.text} />}
          </div>
        ))}
        {streaming && <div className="msg agent"><MarkdownMessage text={streaming} /></div>}
        {busy && !streaming && <div className="msg activity" role="status">正在处理…</div>}
      </div>
      <div className="chat-input">
        <label className="sr-only" htmlFor="design-assistant-input">给设计助手发送消息</label>
        <textarea
          ref={inputRef}
          id="design-assistant-input"
          value={input}
          rows={3}
          placeholder={connection === "connected" ? "描述你想推进的设计工作…" : `${connectionLabels[connection]}，可先输入消息`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              type="button"
              className="composer-tool"
              aria-label="引用当前画布"
              title="引用当前画布"
              onClick={() => insertPrompt("@当前画布 ")}
            >
              <Plus size={17} strokeWidth={1.7} />
            </button>
          </div>
          <div className="composer-actions">
            <button
              type="button"
              className="send"
              aria-label={busy ? "停止生成" : "发送消息"}
              title={connection === "connected" ? (busy ? "停止生成" : "发送消息") : connectionLabels[connection]}
              onClick={busy ? onStop : submit}
              disabled={connection !== "connected" || (!busy && !input.trim())}
            >
              {busy ? <Square size={14} fill="currentColor" strokeWidth={1.5} /> : <ArrowUp size={18} strokeWidth={1.8} />}
            </button>
          </div>
        </div>
      </div>
        </>
      )}
    </aside>
  );
}
