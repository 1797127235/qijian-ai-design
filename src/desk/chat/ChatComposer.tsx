import {
  ArrowUp,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api, type ChatConnectionStatus, type SkillSummary } from "../../lib/api";
import { ATTACHMENT_ACCEPT } from "../attachments";
import type { DeskObject } from "../types";
import type { AttachmentDraftItem } from "../useAttachmentDraft";

const connectionLabels: Record<ChatConnectionStatus, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "正在重连",
  disconnected: "已离线",
};

/** 多选横排条：默认露出的缩略图数，超出收进 +N */
const SELECTION_ROW_MAX = 6;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 选中 chip：主文案用 label；无 label 再回落类型名。 */
function selectionLabel(object: DeskObject) {
  const name = object.label?.trim();
  if (name) {
    if (object.pending) return `${name} · 生成中`;
    if (object.error) return `${name} · 失败`;
    return name;
  }
  if (object.kind === "effect_image") {
    if (object.pending) return "效果图 · 生成中";
    if (object.error) return "效果图 · 失败";
    return "效果图";
  }
  if (object.pending) return "图片 · 生成中";
  if (object.error) return "图片 · 失败";
  if (!object.url) return "图片 · 空占位";
  return "画布图";
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
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const skillsMenuId = useId();

  useEffect(() => {
    if (!skillsOpen) return;
    let cancelled = false;
    if (skills === null) {
      setSkillsLoading(true);
      setSkillsError(null);
      void api.listSkills()
        .then((res) => {
          if (cancelled) return;
          setSkills(res.skills);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSkillsError(err instanceof Error ? err.message : "加载失败");
          setSkills([]);
        })
        .finally(() => {
          if (!cancelled) setSkillsLoading(false);
        });
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = composerRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        setSkillsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSkillsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [skillsOpen, skills]);

  const placeholder = connection !== "connected"
    ? `${connectionLabels[connection]}，可先输入消息`
    : selectedObjects.length > 0
      ? "基于选中物件继续…"
      : skillsOpen
        ? "描述你的想法，或点选上方技能"
        : "描述你想推进的设计工作…";

  const pickSkill = (skill: SkillSummary) => {
    const hint = `请按领域技能「${skill.title}」推进（skill:${skill.id}）。`;
    const next = input.trim() ? `${input.trim()}\n${hint}` : hint;
    setInput(next);
    setSkillsOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div
      ref={composerRef}
      className={`chat-input${skillsOpen ? " skills-open" : ""}`}
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
      {skillsOpen && (
        <div
          id={skillsMenuId}
          className="composer-skills-panel"
          role="menu"
          aria-label="技能列表"
        >
          <div className="composer-skills-head">
            <span className="composer-skills-title">技能</span>
            {skills && skills.length > 0 && (
              <span className="composer-skills-count">{skills.length}</span>
            )}
          </div>
          {skillsLoading && (
            <p className="composer-skills-status" role="status">加载中…</p>
          )}
          {!skillsLoading && skillsError && (
            <p className="composer-skills-status is-error" role="alert">{skillsError}</p>
          )}
          {!skillsLoading && !skillsError && skills?.length === 0 && (
            <p className="composer-skills-status" role="status">暂无可用技能</p>
          )}
          {!skillsLoading && !skillsError && skills && skills.length > 0 && (
            <ul className="composer-skills-list" role="none">
              {skills.map((skill) => (
                <li key={skill.id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-skills-item"
                    disabled={draftLocked}
                    onClick={() => pickSkill(skill)}
                  >
                    <span className="composer-skills-item-icon" aria-hidden="true">
                      <Sparkles size={13} strokeWidth={1.8} />
                    </span>
                    <span className="composer-skills-item-copy">
                      <span className="composer-skills-item-title">{skill.title}</span>
                      <span className="composer-skills-item-desc">{skill.summary || skill.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* 画布选中即时 chip：一点选就显示，发送时才经 selectedArtifactIds 给 Agent */}
      {selectedObjects.length > 0 && (
        <div
          className="composer-selection"
          aria-label={`已选中 ${selectedObjects.length} 个桌面物件，发送时告诉助手`}
          title={`已选中 ${selectedObjects.length} 个 · 发送时告诉助手`}
        >
          {selectedObjects.length > 3 ? (
            <div className="composer-selection-row">
              {(selectionExpanded ? selectedObjects : selectedObjects.slice(0, SELECTION_ROW_MAX)).map((selectedObject) => {
                const previewUrl = selectionPreview(selectedObject);
                const label = selectionLabel(selectedObject);
                return (
                  <div key={selectedObject.id} className="composer-selection-thumb" title={label}>
                    {previewUrl
                      ? <img src={previewUrl} alt="" />
                      : <ImageIcon size={14} strokeWidth={1.6} />}
                    <button
                      type="button"
                      className="composer-selection-thumb-remove"
                      aria-label={`取消选中 ${label}`}
                      title="取消选中"
                      disabled={draftLocked}
                      onClick={() => onClearSelection?.(selectedObject.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
              {!selectionExpanded && selectedObjects.length > SELECTION_ROW_MAX && (
                <button
                  type="button"
                  className="composer-selection-more"
                  aria-label={`还有 ${selectedObjects.length - SELECTION_ROW_MAX} 个，点击展开`}
                  title={`还有 ${selectedObjects.length - SELECTION_ROW_MAX} 个 · 点击展开`}
                  onClick={() => setSelectionExpanded(true)}
                >
                  +{selectedObjects.length - SELECTION_ROW_MAX}
                </button>
              )}
              {selectionExpanded && (
                <button
                  type="button"
                  className="composer-selection-more"
                  aria-label="收起"
                  title="收起"
                  onClick={() => setSelectionExpanded(false)}
                >
                  <ChevronUp size={12} />
                </button>
              )}
            </div>
          ) : (
            selectedObjects.map((selectedObject) => {
              const previewUrl = selectionPreview(selectedObject);
              const label = selectionLabel(selectedObject);
              return (
                <div key={selectedObject.id} className="composer-selection-chip">
                  <div className="composer-selection-preview" aria-hidden="true">
                    {previewUrl
                      ? <img src={previewUrl} alt="" />
                      : <ImageIcon size={13} strokeWidth={1.6} />}
                  </div>
                  <span className="composer-selection-name" title={label}>{label}</span>
                  <button
                    type="button"
                    className="composer-attachment-action"
                    aria-label={`取消选中 ${label}`}
                    title="取消选中"
                    disabled={draftLocked}
                    onClick={() => onClearSelection?.(selectedObject.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })
          )}
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
          <button
            type="button"
            className={`composer-tool${skillsOpen ? " is-open" : ""}`}
            aria-label="技能"
            title="技能"
            aria-haspopup="menu"
            aria-expanded={skillsOpen}
            aria-controls={skillsMenuId}
            disabled={draftLocked}
            onClick={() => setSkillsOpen((open) => !open)}
          >
            <Sparkles size={16} strokeWidth={1.7} />
          </button>
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
