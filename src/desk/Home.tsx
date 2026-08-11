import { useRef, useState } from "react";
import { api, type ProjectSummary } from "../lib/api";
import { useExitTransition } from "./useExitTransition";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
  validateAttachmentFile,
} from "./attachments";

/** 校验一批待创建项目附件；返回错误文案（合法返回 undefined）。 */
function validateNewFiles(current: File[], picked: File[]): string | undefined {
  const invalid = picked.find((file) => Boolean(validateAttachmentFile(file)));
  if (invalid) return `${invalid.name}：${validateAttachmentFile(invalid)}`;
  if (current.length + picked.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`;
  }
  if ([...current, ...picked].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    return "附件总大小不能超过 60MB";
  }
  return undefined;
}

function DeskPreview({ coverFileId }: { coverFileId?: string | null }) {
  // 有封面：server 预渲染的真实桌面拼板；无封面：诚实画一张空桌面骨架，不假装有图
  if (coverFileId) {
    return (
      <div className="desk-thumb">
        <img src={api.fileUrl(coverFileId)} alt="" loading="lazy" />
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

const EXAMPLES = ["静安寺老公房两居室改造", "滨江三居室 · 现代东方", "顶层复式 · 亲子宅"];

export function Home({
  projects,
  error,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  projects: ProjectSummary[];
  error?: string;
  onOpen: (project: ProjectSummary) => void;
  onCreate: (input: { name: string; files?: File[]; prompt?: string }) => Promise<void>;
  onRename: (project: ProjectSummary, name: string) => Promise<void>;
  onDelete: (project: ProjectSummary) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const createModal = useExitTransition(createOpen ? true : undefined, 120);
  const [createName, setCreateName] = useState("");
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  const focusInput = () => inputRef.current?.focus();

  const submit = async () => {
    if (submitting) return;
    const prompt = name.trim();
    setSubmitting(true);
    setFormError(undefined);
    try {
      // 名字交给 LLM 总结（首条消息触发自动起名）；这里先落默认名，用户后续可改
      await onCreate({ name: "未命名项目", files, prompt: prompt || undefined });
      setName("");
      setFiles([]);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  /** 弹窗新建：字段全可选；空提交 = 「未命名」白画板，带图则图片落桌为首个资产 */
  const confirmCreate = async () => {
    if (submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      await onCreate({ name: createName.trim() || "未命名项目", files: createFiles });
      setCreateOpen(false);
      setCreateName("");
      setCreateFiles([]);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const commitRename = async (project: ProjectSummary, next: string) => {
    const trimmed = next.trim();
    setRenamingId(undefined);
    if (!trimmed || trimmed === project.name) return;
    try {
      await onRename(project, trimmed);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "改名失败");
    }
  };

  return (
    <div className="home-shell">
      <nav className="home-rail" aria-label="主导航">
        <img className="brand-mark rail-seal" src="/brand-mark.svg" alt="Qijian" width={30} height={30} />
        <button type="button" className="rail-btn" title="新建项目" aria-label="新建项目" disabled={submitting} onClick={() => setCreateOpen(true)}>
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
            <h1 className="home-title"><img className="brand-mark hero-seal" src="/brand-mark.svg" alt="" width={52} height={52} />砌间，专注设计判断</h1>
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
                const problem = validateNewFiles(files, picked);
                if (problem) setFormError(problem);
                else if (picked.length > 0) {
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
              <button type="button" className="home-card home-card-new" disabled={submitting} onClick={() => setCreateOpen(true)}>
                <div className="desk-thumb desk-thumb-new">
                  <span className="home-card-plus">＋</span>
                </div>
                <span className="home-card-name">{submitting ? "创建中…" : "新建项目"}</span>
              </button>
              {projects.map((p) => (
                <div className="home-card" key={p.id}>
                  <button type="button" className="home-card-open" onClick={() => onOpen(p)}>
                    <DeskPreview coverFileId={p.coverFileId} />
                    <div className="home-card-cap">
                      {renamingId === p.id ? (
                        <input
                          className="home-card-name-input"
                          autoFocus
                          defaultValue={p.name}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(p, e.currentTarget.value);
                            if (e.key === "Escape") setRenamingId(undefined);
                          }}
                          onBlur={(e) => void commitRename(p, e.currentTarget.value)}
                        />
                      ) : (
                        <span className="home-card-name">{p.name}</span>
                      )}
                      <span className="home-card-meta">
                        更新于 {new Date(p.updatedAt).toLocaleDateString("zh-CN")}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="home-card-rename"
                    title="改名"
                    aria-label={`改名 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(p.id);
                    }}
                  >
                    改名
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

      {createModal.rendered && (
        <div
          className={`home-modal-overlay${createModal.closing ? " closing" : ""}`}
          onClick={() => !submitting && setCreateOpen(false)}
        >
          <div
            className="home-modal"
            role="dialog"
            aria-label="添加项目"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="home-modal-head">
              <h3>添加项目</h3>
              <button
                type="button"
                className="home-modal-close"
                aria-label="关闭"
                disabled={submitting}
                onClick={() => setCreateOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="home-modal-label" htmlFor="create-project-name">项目名称</label>
            <input
              id="create-project-name"
              className="home-modal-input"
              autoFocus
              value={createName}
              placeholder="未命名"
              maxLength={200}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmCreate();
                if (e.key === "Escape") setCreateOpen(false);
              }}
            />
            <span className="home-modal-label">导入画布</span>
            <button
              type="button"
              className="home-modal-upload"
              onClick={() => createFileInputRef.current?.click()}
            >
              ⇪ 上传项目文件
            </button>
            {createFiles.length > 0 && (
              <div className="home-files">
                {createFiles.map((file, index) => (
                  <span className="home-file-chip" key={`${file.name}-${index}`}>
                    {file.name}
                    <button
                      type="button"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setCreateFiles((cur) => cur.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              ref={createFileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                const problem = validateNewFiles(createFiles, picked);
                if (problem) setFormError(problem);
                else if (picked.length > 0) {
                  setFormError(undefined);
                  setCreateFiles((cur) => [...cur, ...picked]);
                }
                e.target.value = "";
              }}
            />
            <div className="home-modal-actions">
              <button type="button" className="home-modal-cancel" disabled={submitting} onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button type="button" className="home-modal-confirm" disabled={submitting} onClick={() => void confirmCreate()}>
                {submitting ? "创建中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
