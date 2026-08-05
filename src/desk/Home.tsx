import { useEffect, useState } from "react";
import type { ProjectSummary } from "../lib/api";

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
  onCreate: (input: { name: string }) => Promise<void>;
  onDelete: (project: ProjectSummary) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();

  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);

  const submit = async () => {
    const n = name.trim() || "未命名项目";
    setSubmitting(true);
    setFormError(undefined);
    try {
      await onCreate({ name: n });
      setName("");
      setCreating(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <div>
            <h1>设计桌面</h1>
            <p className="home-sub">{projects.length === 0 ? "从一张空桌面开始" : `${projects.length} 个项目`}</p>
          </div>
          <button type="button" className="new-btn" onClick={() => setCreating(true)}>
            新建项目
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="home-grid">
          {projects.map((p) => (
            <div className="home-card" key={p.id}>
              <button type="button" className="home-card-open" onClick={() => onOpen(p)}>
                <DeskPreview project={p} />
                <div className="home-card-cap">
                  <span className="home-card-name">{p.name}</span>
                  <span className="home-card-meta">
                    {statusLabel(p)}
                    <span className="dot">·</span>
                    {new Date(p.updatedAt).toLocaleDateString("zh-CN")}
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

          <button type="button" className="home-card home-card-new" onClick={() => setCreating(true)}>
            <div className="desk-thumb desk-thumb-new">
              <span className="home-card-plus">＋</span>
              <span className="home-card-plus-label">新建设计桌面</span>
            </div>
          </button>
        </div>
      </div>

      {creating && (
        <div className="home-overlay" role="dialog" aria-modal="true" onClick={() => !submitting && setCreating(false)}>
          <div className="home-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>新建设计桌面</h2>
            <p className="home-dialog-hint">先开一张桌面。户型、项目理解、设计方向和效果图都在桌面上展开。</p>
            <label className="field">
              <span>项目名称</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：静安寺老公房改造"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </label>
            {formError && <p className="error-text">{formError}</p>}
            <div className="home-dialog-actions">
              <button type="button" className="mini-btn" disabled={submitting} onClick={() => setCreating(false)}>
                取消
              </button>
              <button type="button" className="mini-btn primary" disabled={submitting} onClick={() => void submit()}>
                {submitting ? "创建中…" : "打开桌面"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
