import { Trash2 } from "lucide-react";
import type { ChatThread } from "../../lib/api";

export function ChatThreadList({
  threads,
  activeThreadId,
  threadChanging,
  busy,
  onSelect,
  onDelete,
}: {
  threads: ChatThread[];
  activeThreadId?: string;
  threadChanging: boolean;
  busy: boolean;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string, title: string) => void;
}) {
  return (
    <div className="chat-thread-menu" role="dialog" aria-label="对话历史">
      <span className="chat-thread-menu-title">对话历史</span>
      <div className="chat-thread-list">
        {threads.map((thread) => (
          <div key={thread.id} className={`chat-thread-row ${thread.id === activeThreadId ? "active" : ""}`}>
            <button
              type="button"
              className="chat-thread-select"
              disabled={threadChanging || busy}
              onClick={() => onSelect(thread.id)}
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
                if (window.confirm(`确定删除“${thread.title}”吗？删除后无法恢复。`)) onDelete(thread.id, thread.title);
              }}
            >
              <Trash2 size={14} strokeWidth={1.7} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
