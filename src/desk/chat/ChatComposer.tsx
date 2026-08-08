import { ArrowUp, FileText, Image as ImageIcon, LoaderCircle, Plus, RotateCcw, Square, X } from "lucide-react";
import type { ChatConnectionStatus } from "../../lib/api";
import { ATTACHMENT_ACCEPT } from "../attachments";
import type { DeskObject } from "../types";
import type { AttachmentDraftItem } from "../useAttachmentDraft";

const connectionLabels: Record<ChatConnectionStatus, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "正在重连",
  disconnected: "已离线",
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 选中 chip 标题：优先桌面编号 + 类型名（与 Agent alias 对齐）。 */
function selectionLabel(object: DeskObject) {
  const prefix = object.alias ? `${object.alias} · ` : "";
  if (object.kind === "effect_image") {
    if (object.pending) return `${prefix}效果图 · 生成中`;
    if (object.error) return `${prefix}效果图 · 失败`;
    return `${prefix}效果图`;
  }
  if (object.pending) return `${prefix}图片 · 生成中`;
  if (object.error) return `${prefix}图片 · 失败`;
  if (!object.url) return `${prefix}图片 · 空占位`;
  return `${prefix}画布图`;
}

function selectionPreview(object: DeskObject) {
  return object.url;
}

export function ChatComposer({
  input,
  setInput,
  draftLocked,
  connection,
  busy,
  hasContent,
  attachmentsReady,
  items,
  selectedObjects = [],
  onClearSelection,
  fileInputRef,
  inputRef,
  onSubmit,
  onStop,
  onAddFiles,
  onRetry,
  onRemove,
}: {
  input: string;
  setInput: (value: string) => void;
  draftLocked: boolean;
  connection: ChatConnectionStatus;
  busy: boolean;
  hasContent: boolean;
  attachmentsReady: boolean;
  items: AttachmentDraftItem[];
  /** 画布选中引用（非上传附件）；一点选即显示 */
  selectedObjects?: DeskObject[];
  onClearSelection?: (id?: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onSubmit: () => void;
  onStop: () => void;
  onAddFiles: (files: File[]) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const placeholder = connection !== "connected"
    ? `${connectionLabels[connection]}，可先输入消息`
    : selectedObjects.length > 0
      ? "基于选中物件继续…"
      : "描述你想推进的设计工作…";

  return (
    <div
      className="chat-input"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (draftLocked) return;
        onAddFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {/* 画布选中即时 chip：一点选就显示，发送时才经 selectedArtifactIds 给 Agent */}
      {selectedObjects.length > 0 && (
        <div className="composer-selection" aria-label="当前选中的桌面物件">
          {selectedObjects.map((selectedObject) => {
            const previewUrl = selectionPreview(selectedObject);
            return (
              <div key={selectedObject.id} className="composer-selection-chip">
                <div className="composer-selection-preview" aria-hidden="true">
                  {previewUrl
                    ? <img src={previewUrl} alt="" />
                    : <ImageIcon size={16} strokeWidth={1.6} />}
                </div>
                <div className="composer-selection-copy">
                  <span title={selectionLabel(selectedObject)}>{selectionLabel(selectedObject)}</span>
                  <small>已选中 · 发送时告诉助手</small>
                </div>
                <button
                  type="button"
                  className="composer-attachment-action"
                  aria-label="取消选中"
                  title="取消选中"
                  disabled={draftLocked}
                  onClick={() => onClearSelection?.(selectedObject.id)}
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {items.length > 0 && (
        <div className="composer-attachments" aria-label="待发送附件">
          {items.map((item) => (
            <div key={item.localId} className={`composer-attachment ${item.status}`}>
              <div className="composer-attachment-preview" aria-hidden="true">
                {item.previewUrl
                  ? <img src={item.previewUrl} alt="" />
                  : <FileText size={19} strokeWidth={1.6} />}
              </div>
              <div className="composer-attachment-copy">
                <span title={item.file.name}>{item.file.name}</span>
                <small>
                  {item.status === "queued" && "等待上传"}
                  {item.status === "uploading" && "上传中"}
                  {item.status === "uploaded" && `${formatBytes(item.file.size)}${item.stored?.pageCount ? ` · ${item.stored.pageCount} 页` : ""}`}
                  {item.status === "error" && item.error}
                </small>
              </div>
              {item.status === "uploading" && <LoaderCircle className="is-spinning composer-attachment-status" size={15} aria-label="上传中" />}
              {item.status === "error" && !item.error?.includes("仅支持") && !item.error?.includes("30MB") && !item.error?.includes("60MB") && !item.error?.includes("内容为空") && (
                <button
                  type="button"
                  className="composer-attachment-action"
                  aria-label={`重试上传 ${item.file.name}`}
                  title="重试上传"
                  disabled={draftLocked}
                  onClick={() => onRetry(item.localId)}
                >
                  <RotateCcw size={15} />
                </button>
              )}
              <button
                type="button"
                className="composer-attachment-action"
                aria-label={`移除 ${item.file.name}`}
                title="移除附件"
                disabled={draftLocked}
                onClick={() => onRemove(item.localId)}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {items.some((item) => item.status === "uploading") ? "附件正在上传" : ""}
        {items.some((item) => item.status === "error") ? "有附件上传失败" : ""}
      </div>
      <label className="sr-only" htmlFor="design-assistant-input">给设计助手发送消息</label>
      <textarea
        ref={inputRef}
        id="design-assistant-input"
        value={input}
        disabled={draftLocked}
        rows={3}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onPaste={(event) => {
          if (draftLocked) return;
          const files = Array.from(event.clipboardData.files);
          if (files.length > 0) onAddFiles(files);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            type="button"
            className="composer-tool"
            aria-label="添加附件"
            title="添加附件"
            disabled={draftLocked}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={17} strokeWidth={1.7} />
          </button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={(event) => {
              onAddFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <div className="composer-actions">
          <button
            type="button"
            className="send"
            aria-label={busy ? "停止生成" : "发送消息"}
            title={connection === "connected" ? (busy ? "停止生成" : "发送消息") : connectionLabels[connection]}
            onClick={busy ? onStop : onSubmit}
            disabled={connection !== "connected" || (!busy && (!hasContent || !attachmentsReady))}
          >
            {busy ? <Square size={14} fill="currentColor" strokeWidth={1.5} /> : <ArrowUp size={18} strokeWidth={1.8} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export { connectionLabels };
