import { useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { PermissionMode } from "../lib/api";
import type { ChatItem } from "./types";

export interface PendingApproval {
  approvalId: string;
  description: string;
}

export function ChatPanel({
  items,
  streaming,
  permission,
  pending,
  busy,
  onTogglePermission,
  onSend,
  onApprove,
  onReject,
}: {
  items: ChatItem[];
  streaming?: string;
  permission: PermissionMode;
  pending?: PendingApproval;
  busy: boolean;
  onTogglePermission: () => void;
  onSend: (text: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items.length, streaming, pending]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onSend(text);
  };

  return (
    <aside className={`chat ${collapsed ? "chat-collapsed" : ""}`}>
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
          {pending && <span className="chat-pending-dot" aria-label="有待处理的审批" />}
        </button>
      ) : (
        <>
      <div className="chat-head">
        <span className="chat-title">设计助手</span>
        <div className="chat-head-actions">
          <button type="button" className={`perm ${permission}`} title="切换助手权限" onClick={onTogglePermission}>
            {permission === "ask" ? "每步请示" : "完全放手"}
          </button>
          <button
            type="button"
            className="chat-collapse"
            aria-label="折叠设计助手"
            title="折叠设计助手"
            aria-expanded={true}
            onClick={() => setCollapsed(true)}
          >
            <PanelRightClose size={17} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="chat-list" ref={listRef}>
        {items.length === 0 && !streaming && (
          <div className="chat-empty">
            <p>我在桌面上帮你干活。</p>
            <p className="dim">试试：“整理项目理解” · “出三个方向” · “给客厅出效果图”</p>
          </div>
        )}
        {items.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{m.text}</div>
        ))}
        {streaming && <div className="msg agent">{streaming}</div>}
        {busy && !streaming && <div className="msg activity">正在处理…</div>}
        {pending && (
          <div className="approval">
            <p>待你批准：<b>{pending.description}</b></p>
            <div className="approval-btns">
              <button type="button" className="mini-btn" onClick={onReject}>拒绝</button>
              <button type="button" className="mini-btn primary" onClick={onApprove}>批准</button>
            </div>
          </div>
        )}
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          rows={4}
          placeholder="指挥我，比如：给客厅再出一个效果图变体"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="send" onClick={submit} disabled={!input.trim()}>发送</button>
      </div>
        </>
      )}
    </aside>
  );
}
