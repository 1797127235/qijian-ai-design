import { FileText, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatAttachment } from "../../lib/api";
import { safeMarkdownUrl } from "../markdown";
import type { ChatItem } from "../types";

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

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="message-attachments" aria-label="消息附件">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          className="message-attachment"
          href={api.fileUrl(attachment.id)}
          target="_blank"
          rel="noreferrer"
          title={attachment.originalFilename}
        >
          {attachment.mediaType === "application/pdf" ? <FileText size={15} /> : <Paperclip size={15} />}
          <span>{attachment.originalFilename}</span>
        </a>
      ))}
    </div>
  );
}

const suggestions = [
  { title: "整理项目理解", description: "读取当前画布与户型图，提炼空间问题和设计机会" },
  { title: "出三个设计方向", description: "基于当前约束，形成三个真正可比较的方案方向" },
  { title: "给客厅出效果图", description: "结合已确认方向，为重点空间生成视觉方案" },
];

export function ChatMessageList({
  items,
  streaming,
  busy,
  sendDisabled,
  listRef,
  stickToBottom,
  onPickSuggestion,
}: {
  items: ChatItem[];
  streaming?: string;
  busy: boolean;
  sendDisabled: boolean;
  listRef: React.RefObject<HTMLDivElement>;
  stickToBottom: React.MutableRefObject<boolean>;
  onPickSuggestion: (title: string) => void;
}) {
  return (
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
              <button key={suggestion.title} type="button" disabled={sendDisabled} onClick={() => onPickSuggestion(suggestion.title)}>
                <strong>{suggestion.title}</strong>
                <span>{suggestion.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {items.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          {m.role === "agent" ? <MarkdownMessage text={m.text} /> : m.text ? <PlainMessageText text={m.text} /> : null}
          {m.role === "user" && <MessageAttachments attachments={m.attachments ?? []} />}
        </div>
      ))}
      {streaming && <div className="msg agent"><MarkdownMessage text={streaming} /></div>}
      {busy && !streaming && <div className="msg activity" role="status">正在处理…</div>}
    </div>
  );
}
