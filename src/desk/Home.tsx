import { useRef, useState } from "react";
import type { ProjectSummary } from "../lib/api";
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS_PER_MESSAGE, MAX_TOTAL_ATTACHMENT_BYTES, validateAttachmentFile } from "./attachments";

function DeskPreview({ project }: { project: ProjectSummary }) {
  if (project.coverUrl) {
    return (
      <div className="desk-thumb">
        <img src={project.coverUrl} alt="" loading="lazy" />
      </div>
    );
  }
  return (
    <div className="desk-thumb desk-thumb-empty" aria-hidden="true">
      <div className="desk-thumb-dots" />
      <div className="desk-thumb-plan" />
      <div className="desk-thumb-note n1" />
      <div className="desk-thumb-note n2" />
    </div>
  );
}

function statusLabel(p: ProjectSummary): string {
  if (p.directionTitle) return p.directionTitle;
  if (p.effectCount > 0) return `效果图 ${p.adoptedCount}/${p.effectCount}`;
  return "空桌面";
}

const EXAMPLES = ["静安寺老公房两居室改造", "滨江三居室 · 现代东方", "顶层复式 · 亲子宅"];

export function Home({
  projects,
  error,
  onOpen,
  onCreate,
  onDelete,
}: {
  projects: ProjectSummary[];
  error?: string;
  onOpen: (project: ProjectSummary) => void;
  onCreate: (input: { name: string; files?: File[]; prompt?: string }) => Promise<void>;
  onDelete: (project: ProjectSummary) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const focusInput = () => inputRef.current?.focus();

  const submit = async () => {
    if (submitting) return;
    const prompt = name.trim();
    setSubmitting(true);
    setFormError(undefined);
    try {
      await onCreate({ name: prompt || "未命名项目", files, prompt: prompt || undefined });
      setName("");
      setFiles([]);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "创建失败");
      setSubmitting(false);
    }
  };

  return (
    <div className="home-shell">
      <nav className="home-rail" aria-label="主导航">
        <span className="seal-box rail-seal">砌</span>
        <button type="button" className="rail-btn" title="新建项目" aria-label="新建项目" onClick={focusInput}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="rail-btn active" title="项目列表" aria-label="项目列表" aria-current="page">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3 7.6 9 3l6 4.6V15H3V7.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
      </nav>

      <div className="home-main">
        <div className="home-center">
          <header className="home-hero">
            <h1 className="home-title"><span className="seal-box hero-seal">砌</span>砌间，专注设计判断</h1>
            <p className="home-tagline">琐碎的交给代理：空间理解、设计方向、效果图与提案包，都在一张桌面上</p>

            <div className="home-prompt">
              <textarea
                ref={inputRef}
                rows={2}
                value={name}
                placeholder="描述新项目的空间，如：静安寺老公房两居室改造"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              {files.length > 0 && (
                <div className="home-files">
                  {files.map((file, index) => (
                    <span className="home-file-chip" key={`${file.name}-${index}`}>
                      {file.name}
                      <button
                        type="button"
                        aria-label={`移除 ${file.name}`}
                        onClick={() => setFiles((cur) => cur.filter((_, i) => i !== index))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="home-prompt-bar">
                <button
                  type="button"
                  className="home-attach"
                  title="添加附件"
                  aria-label="添加附件"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <span className="home-prompt-hint">{files.length > 0 && !name.trim() ? "回车带着资料开一张新桌面" : ""}</span>
                <button
                  type="button"
                  className="home-send"
                  disabled={submitting}
                  title="创建设计桌面"
                  aria-label="创建设计桌面"
                  onClick={() => void submit()}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                const invalid = picked.find((file) => Boolean(validateAttachmentFile(file)));
                if (invalid) {
                  setFormError(`${invalid.name}：${validateAttachmentFile(invalid)}`);
                } else if (files.length + picked.length > MAX_ATTACHMENTS_PER_MESSAGE) {
                  setFormError(`每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
                } else if ([...files, ...picked].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
                  setFormError("每条消息的附件总大小不能超过 60MB");
                } else if (picked.length > 0) {
                  setFormError(undefined);
                  setFiles((cur) => [...cur, ...picked]);
                }
                e.target.value = "";
              }}
            />

            <div className="home-chips">
              {EXAMPLES.map((example) => (
                <button
                  type="button"
                  key={example}
                  className="home-chip"
                  onClick={() => {
                    setName(example);
                    focusInput();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>

            {(error || formError) && <p className="error-text">{formError ?? error}</p>}
          </header>
        </div>

        <section className="home-recent" aria-label="最近项目">
            <h2>最近项目{projects.length > 0 ? ` · ${projects.length}` : ""}</h2>
            <div className="home-row">
              <button type="button" className="home-card home-card-new" onClick={focusInput}>
                <div className="desk-thumb desk-thumb-new">
                  <span className="home-card-plus">＋</span>
                </div>
                <span className="home-card-name">新建项目</span>
              </button>
              {projects.map((p) => (
                <div className="home-card" key={p.id}>
                  <button type="button" className="home-card-open" onClick={() => onOpen(p)}>
                    <DeskPreview project={p} />
                    <div className="home-card-cap">
                      <span className="home-card-name">{p.name}</span>
                      <span className="home-card-meta">
                        {statusLabel(p)}
                        <span className="dot">·</span>
                        更新于 {new Date(p.updatedAt).toLocaleDateString("zh-CN")}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="home-card-del"
                    disabled={deletingId === p.id}
                    title="删除项目"
                    aria-label={`删除 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm(`删除「${p.name}」？桌面上的资料和效果图会一并清除，且不可恢复。`)) return;
                      setDeletingId(p.id);
                      void onDelete(p).finally(() => setDeletingId(undefined));
                    }}
                  >
                    {deletingId === p.id ? "…" : "删除"}
                  </button>
                </div>
              ))}
            </div>
        </section>
      </div>
    </div>
  );
}
