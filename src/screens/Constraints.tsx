import { useEffect, useState } from "react";
import { Badge, GateBar, Seal, Spinner, TaskState } from "../components/ui";
import type {
  AiTask,
  ConstraintModuleId,
  ConstraintSourceKind,
  ConstraintStrength,
  DesignConstraintItem,
  DesignSystemPayload,
  Versioned,
} from "../lib/api";

const sourceLabels: Record<ConstraintSourceKind, string> = {
  source_fact: "来源事实",
  design_decision: "设计决策",
  designer_added: "设计师添加",
};
const strengthLabels: Record<ConstraintStrength, string> = { hard: "硬", soft: "软", unresolved: "待" };
const strengthTone: Record<ConstraintStrength, "hard" | "soft" | "tbc"> = { hard: "hard", soft: "soft", unresolved: "tbc" };

export function ConstraintsScreen({
  task,
  constraints,
  error,
  saving,
  onRetry,
  onSave,
  onRegenerateModule,
  moduleTask,
}: {
  task?: AiTask;
  constraints?: Versioned<DesignSystemPayload>;
  error?: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (payload: DesignSystemPayload, status: "draft" | "confirmed") => Promise<void>;
  onRegenerateModule: (moduleId: ConstraintModuleId) => void;
  moduleTask?: AiTask;
}) {
  const [draft, setDraft] = useState<DesignSystemPayload>();
  const [openModules, setOpenModules] = useState<Set<ConstraintModuleId>>(new Set());
  useEffect(() => {
    setDraft(constraints?.payload);
    if (constraints?.payload.modules[0]) setOpenModules(new Set([constraints.payload.modules[0].module_id]));
  }, [constraints?.artifactId, constraints?.payload]);

  if ((task && ["pending", "running"].includes(task.status)) || (!task && !constraints)) {
    return <TaskState title="正在生成方案约束草稿" detail="正在把已确认的空间策略整理为可编辑的家装约束包（8 模块）。" />;
  }
  if (task?.status === "failed" || !draft) {
    return (
      <TaskState error title="方案约束包未生成"
        detail={task?.error_message || error || "暂时无法生成方案约束包。"}
        action={<button type="button" className="btn primary" onClick={onRetry}>重新生成 →</button>} />
    );
  }

  const confirmed = constraints?.status === "confirmed";
  const toggle = (id: ConstraintModuleId) =>
    setOpenModules((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const editItem = (moduleId: ConstraintModuleId | "prohibited", constraintId: string, text: string) =>
    setDraft((c) => {
      if (!c) return c;
      const patch = (items: DesignConstraintItem[]) =>
        items.map((it) => (it.constraint_id === constraintId ? { ...it, text, designer_edited: true } : it));
      if (moduleId === "prohibited") return { ...c, prohibited_items: patch(c.prohibited_items) };
      return { ...c, modules: c.modules.map((m) => (m.module_id === moduleId ? { ...m, items: patch(m.items) } : m)) };
    });
  const resolveConflict = (conflictId: string, resolution: string) =>
    setDraft((c) => c && ({
      ...c,
      conflicts: c.conflicts.map((cf) => (cf.conflict_id === conflictId ? { ...cf, status: "resolved", resolution } : cf)),
    }));

  const counts = countConstraints(draft);
  const unresolvedConflicts = draft.conflicts.filter((c) => c.status === "unresolved");
  const regenerating = moduleTask && ["pending", "running"].includes(moduleTask.status);

  return (
    <div className="page">
      <p className="eyebrow">方案约束包 · 所有视图共享的设计基线</p>
      <h1 className="h-display">八个模块，一份基线</h1>
      <p className="lede">每条约束标明来源（事实 / 决策 / 添加）与强度（硬 / 软 / 待确认）。约束包版本化，画布与效果图变体继承同一版本。</p>
      {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}

      <div className="split">
        <div>
          {draft.modules.map((m) => {
            const open = openModules.has(m.module_id);
            const hasHard = m.items.some((it) => it.strength === "hard");
            const hasTbc = m.items.some((it) => it.strength === "unresolved");
            return (
              <div className={`card module ${open ? "open" : ""}`} key={m.module_id}>
                <button type="button" className="module-head" aria-expanded={open} onClick={() => toggle(m.module_id)}>
                  <span className="caret" aria-hidden="true">▸</span>
                  <span><span className="t">{m.title}</span><span className="s">{m.module_id} · {m.items.length} 条</span></span>
                  {hasTbc ? <Badge tone="tbc">待确认</Badge> : hasHard ? <Badge tone="hard">含硬约束</Badge> : <Badge tone="soft">软约束为主</Badge>}
                  <span className="mono">v1</span>
                </button>
                <div className="module-body"><div><div className="inner">
                  {m.summary && <p className="mono" style={{ margin: "6px 0 10px" }}>{m.summary}</p>}
                  {m.items.map((it) => (
                    <ConstraintRow key={it.constraint_id} item={it} editable={!confirmed}
                      onEdit={(text) => editItem(m.module_id, it.constraint_id, text)} />
                  ))}
                  {!confirmed && (
                    <div style={{ padding: "10px 0 0" }}>
                      <button type="button" className="btn ghost" style={{ minHeight: 28, fontSize: 12, padding: "2px 6px" }}
                        disabled={regenerating} onClick={() => onRegenerateModule(m.module_id)}>
                        {regenerating ? <><Spinner /> 重新生成中…</> : "↻ 重新生成此模块"}
                      </button>
                    </div>
                  )}
                </div></div></div>
              </div>
            );
          })}

          <p className="eyebrow" style={{ color: "var(--color-error)", marginTop: 24 }}>禁止清单 · prohibited_items</p>
          <div className="card" style={{ padding: "4px 16px" }}>
            {draft.prohibited_items.map((it) => (
              <div className="c-item" key={it.constraint_id}>
                <Badge tone="ban">禁</Badge>
                <div className={`txt ${it.designer_edited ? "edited" : ""}`}>
                  {it.text}
                  <span className="src">{sourceLabels[it.source_kind]} · {it.source_ref}</span>
                </div>
                <span />
              </div>
            ))}
          </div>
        </div>

        <aside className="side-stack">
          {draft.conflicts.length > 0 && (
            <div>
              {draft.conflicts.map((cf) => (
                <div className={`conflict-box ${cf.status === "resolved" ? "resolved" : ""}`} key={cf.conflict_id} style={{ marginBottom: 10 }}>
                  <h3>{cf.status === "resolved" ? "✓ 冲突已处理" : "⚠ 约束冲突 · 待处理"}</h3>
                  <p>{cf.text}</p>
                  {cf.status === "resolved" ? (
                    <p className="mono" style={{ margin: 0, color: "var(--color-success)" }}>处理方式：{cf.resolution}</p>
                  ) : confirmed ? (
                    <p className="mono" style={{ margin: 0 }}>关联 {cf.related_constraint_ids.length} 条约束 · 需回到草稿处理</p>
                  ) : (
                    <>
                      <div className="resolve">
                        <button type="button" className="btn secondary" onClick={() => resolveConflict(cf.conflict_id, "调整需求以适配事实约束")}>调整需求</button>
                        <button type="button" className="btn secondary" onClick={() => resolveConflict(cf.conflict_id, "另行询价或技术评估后决定")}>评估后定</button>
                        <button type="button" className="btn ghost" onClick={() => resolveConflict(cf.conflict_id, "设计师已知晓，接受现状")}>标记已知晓</button>
                      </div>
                      <p className="mono" style={{ margin: "12px 0 0", color: "var(--color-warning)" }}>conflict · {cf.conflict_id} · 关联 {cf.related_constraint_ids.length} 条约束 · AI 不做静默裁决</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ padding: 18 }}>
            <span className="mono" style={{ letterSpacing: "0.1em" }}>统计</span>
            <div className="stats-row">
              <span><b style={{ color: "var(--color-accent)" }}>{counts.hard}</b> 硬</span>
              <span><b>{counts.soft}</b> 软</span>
              <span><b style={{ color: "var(--color-warning)" }}>{counts.unresolved}</b> 待确认</span>
              <span><b style={{ color: "var(--color-error)" }}>{draft.prohibited_items.length}</b> 禁止</span>
            </div>
          </div>

          {confirmed ? (
            <GateBar note="约束包已确认。提案画布与效果图变体将继承此版本。">
              <Seal>✓ 约束包已确认</Seal>
            </GateBar>
          ) : (
            <GateBar note={unresolvedConflicts.length ? `还有 ${unresolvedConflicts.length} 条冲突待处理。冲突处理完毕后确认基线。` : "确认后提案画布将继承此版本。"}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn secondary" disabled={saving} onClick={() => onSave(draft, "draft")}>保存草稿</button>
                <button type="button" className="btn primary" disabled={saving || unresolvedConflicts.length > 0} data-state={saving ? "loading" : undefined} onClick={() => onSave(draft, "confirmed")}>
                  {saving ? <><Spinner /> 正在确认…</> : "确认约束包 →"}
                </button>
              </div>
            </GateBar>
          )}
        </aside>
      </div>
    </div>
  );
}

function ConstraintRow({ item, editable, onEdit }: { item: DesignConstraintItem; editable: boolean; onEdit: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  return (
    <div className="c-item">
      <Badge tone={strengthTone[item.strength]}>{strengthLabels[item.strength]}</Badge>
      {editing ? (
        <div>
          <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label="编辑约束" />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button type="button" className="btn primary" style={{ minHeight: 28, padding: "4px 10px", fontSize: 12 }}
              onClick={() => { onEdit(text); setEditing(false); }}>保存</button>
            <button type="button" className="btn ghost" style={{ minHeight: 28, padding: "4px 10px", fontSize: 12 }}
              onClick={() => { setText(item.text); setEditing(false); }}>取消</button>
          </div>
        </div>
      ) : (
        <div className={`txt ${item.designer_edited ? "edited" : ""}`}>
          {item.text}
          <span className="src">{sourceLabels[item.source_kind]} · {item.source_ref}{item.designer_edited ? " · 已编辑" : ""}</span>
        </div>
      )}
      <div className="acts">
        {editable && !editing && (
          <button type="button" className="btn ghost" onClick={() => setEditing(true)}>编辑</button>
        )}
      </div>
    </div>
  );
}

function countConstraints(payload: DesignSystemPayload) {
  const all = payload.modules.flatMap((m) => m.items);
  return {
    hard: all.filter((i) => i.strength === "hard").length,
    soft: all.filter((i) => i.strength === "soft").length,
    unresolved: all.filter((i) => i.strength === "unresolved").length,
  };
}
