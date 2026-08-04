import { useEffect, useState } from "react";
import { Badge, GateBar, Seal, Spinner, TaskState } from "../components/ui";
import type { AiTask, ProjectUnderstandingPayload, Versioned } from "../lib/api";

export function UnderstandingScreen({
  task,
  understanding,
  error,
  saving,
  onRetry,
  onSave,
  onGenerateDirections,
}: {
  task?: AiTask;
  understanding?: Versioned<ProjectUnderstandingPayload>;
  error?: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (payload: ProjectUnderstandingPayload, status: "draft" | "confirmed") => Promise<void>;
  onGenerateDirections: () => void;
}) {
  const [draft, setDraft] = useState<ProjectUnderstandingPayload>();
  useEffect(() => setDraft(understanding?.payload), [understanding?.artifactId, understanding?.payload]);

  if ((task && ["pending", "running"].includes(task.status)) || (!task && !understanding)) {
    return <TaskState title="正在生成项目理解草稿" detail="正在读取 Brief 与户型资料，完成后你可以直接编辑全部内容。" />;
  }
  if (task?.status === "failed" || !draft) {
    return (
      <TaskState error title="项目理解草稿未生成"
        detail={task?.error_message || error || "暂时无法生成项目理解。"}
        action={<button type="button" className="btn primary" onClick={onRetry}>重新生成 →</button>} />
    );
  }

  const confirmed = understanding?.status === "confirmed";
  const summary = draft.project_and_household_summary;

  if (confirmed) {
    return (
      <div className="page">
        <p className="eyebrow">项目理解卡 · 已确认</p>
        <h1 className="h-display">项目理解已确认</h1>
        <p className="lede">本次确认的内容会作为设计方向生成的唯一输入。</p>
        <div className="split">
          <div className="card u-card">
            <div className="u-item ok"><span className="dot" /><div><strong>项目摘要：</strong>{summary.project_summary}</div></div>
            <div className="u-item ok"><span className="dot" /><div><strong>居住者摘要：</strong>{summary.household_summary}</div></div>
            {draft.space_and_room_review.map((s, i) => (
              <div className="u-item ok" key={`${s.name}-${i}`}><span className="dot" /><div><strong>{s.name}：</strong>{s.proposed_use}<span className="mono" style={{ display: "block" }}>{s.relationship_notes}</span></div></div>
            ))}
          </div>
          <aside className="side-stack">
            <GateBar note="理解卡已确认并锁定。需要修改时，从 Brief 重新发起一份理解草稿。">
              <Seal>✓ 事实基线已确认</Seal>
              <button type="button" className="btn primary" onClick={onGenerateDirections}>生成设计方向 →</button>
            </GateBar>
          </aside>
        </div>
      </div>
    );
  }

  const updateSummary = (field: "project_summary" | "household_summary", value: string) =>
    setDraft((c) => c && { ...c, project_and_household_summary: { ...c.project_and_household_summary, [field]: value } });
  const updateSpace = (index: number, field: "name" | "proposed_use" | "relationship_notes", value: string) =>
    setDraft((c) => c && { ...c, space_and_room_review: c.space_and_room_review.map((s, i) => (i === index ? { ...s, [field]: value } : s)) });
  const updateList = (field: "circulation_and_opening_relationships" | "designer_discussion_points", index: number, value: string) =>
    setDraft((c) => c && { ...c, [field]: c[field].map((item, i) => (i === index ? value : item)) });

  return (
    <div className="page">
      <p className="eyebrow">项目理解卡 · AI 整理 · 待逐项核对</p>
      <h1 className="h-display">AI 当前的理解，请你逐项修正</h1>
      <p className="lede">理解卡不是分析结论，而是一份可编辑的核对清单。修改后保存，确认的版本才会作为后续设计的输入。</p>
      {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}

      <div className="split">
        <div>
          <label className="field fact"><span>项目摘要</span>
            <textarea className="textarea" rows={3} value={summary.project_summary} onChange={(e) => updateSummary("project_summary", e.target.value)} /><span className="helper" /></label>
          <label className="field fact"><span>居住者摘要</span>
            <textarea className="textarea" rows={2} value={summary.household_summary} onChange={(e) => updateSummary("household_summary", e.target.value)} /><span className="helper" /></label>

          <p className="mono" style={{ margin: "8px 0 10px", letterSpacing: "0.1em", textTransform: "uppercase" }}>空间与房间梳理</p>
          {draft.space_and_room_review.map((s, i) => (
            <div className="card" key={`${s.name}-${i}`} style={{ padding: 16, marginBottom: 10 }}>
              <label className="field fact" style={{ marginBottom: 10 }}><span>空间名称</span>
                <input className="input" value={s.name} onChange={(e) => updateSpace(i, "name", e.target.value)} /></label>
              <label className="field fact" style={{ marginBottom: 10 }}><span>功能理解</span>
                <textarea className="textarea" rows={2} value={s.proposed_use} onChange={(e) => updateSpace(i, "proposed_use", e.target.value)} /></label>
              <label className="field" style={{ marginBottom: 0 }}><span>关系说明</span>
                <textarea className="textarea" rows={2} value={s.relationship_notes} onChange={(e) => updateSpace(i, "relationship_notes", e.target.value)} /></label>
            </div>
          ))}

          <EditableList label="动线与开口关系" values={draft.circulation_and_opening_relationships} onChange={(i, v) => updateList("circulation_and_opening_relationships", i, v)} />
          <EditableList label="设计师讨论点" values={draft.designer_discussion_points} onChange={(i, v) => updateList("designer_discussion_points", i, v)} />
        </div>

        <aside className="side-stack">
          <div className="card" style={{ padding: 18 }}>
            <h2 className="h-card">核对说明</h2>
            <p className="lede" style={{ fontSize: 12.5, marginTop: 6 }}>这张卡没有模型置信度标签。所有内容均可由你直接改写；待确认项不进入共享事实基线。</p>
          </div>
          <GateBar note="全部核对完成后确认事实基线，解锁设计方向集生成。">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn secondary" disabled={saving} onClick={() => onSave(draft, "draft")}>保存草稿</button>
              <button type="button" className="btn primary" disabled={saving} data-state={saving ? "loading" : undefined} onClick={() => onSave(draft, "confirmed")}>
                {saving ? <><Spinner /> 正在保存…</> : "确认事实基线 →"}
              </button>
            </div>
          </GateBar>
        </aside>
      </div>
    </div>
  );
}

function EditableList({ label, values, onChange }: { label: string; values: string[]; onChange: (index: number, value: string) => void }) {
  return (
    <div className="fact">
      <p className="mono" style={{ margin: "8px 0 10px", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</p>
      {values.length === 0 && <p className="mono">暂未添加。</p>}
      {values.map((v, i) => (
        <label className="field" key={i} style={{ marginBottom: 8 }}>
          <input className="input" value={v} onChange={(e) => onChange(i, e.target.value)} aria-label={`${label} ${i + 1}`} />
        </label>
      ))}
    </div>
  );
}
