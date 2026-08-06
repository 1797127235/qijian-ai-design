import { FileText, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatAttachment } from "../../lib/api";
import { safeMarkdownUrl } from "../markdown";
import type { ChatItem } from "../types";
import { ProcessPanel } from "./ProcessPanel";

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
  { title: "看看桌上有什么", description: "根据当前画布与附件，帮我理清已有材料和缺口" },
  { title: "按我说的改一版", description: "以我选中或提到的图为准，出一版可比较的改法" },
  { title: "给这个空间出效果图", description: "用现有参考或描述，生成一张可落桌的效果图" },
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
      {items.filter((m) => m.role !== "process").length === 0 && !streaming && !busy && (
        <div className="chat-empty">
          <div className="chat-empty-intro">
            <span>砌间设计助手</span>
            <h2>想做什么？</h2>
            <p>把图或想法丢进来；我会尽量结合当前画布一起改。</p>
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
      {items.map((m) => {
        if (m.role === "process") {
          return <ProcessPanel key={m.id} process={m.process} />;
        }
        return (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "agent" ? <MarkdownMessage text={m.text} /> : m.text ? <PlainMessageText text={m.text} /> : null}
            {m.role === "user" && <MessageAttachments attachments={m.attachments ?? []} />}
          </div>
        );
      })}
      {streaming && <div className="msg agent"><MarkdownMessage text={streaming} /></div>}
      {/* 已有过程条时不要再叠「正在处理…」（工具失败后 status 可能短暂不是 running） */}
      {busy && !streaming && !items.some((m) => m.role === "process") && (
        <div className="msg activity" role="status">正在处理…</div>
      )}
    </div>
  );
}
