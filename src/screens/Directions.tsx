import { useEffect, useState } from "react";
import { Badge, GateBar, Seal, Spinner, TaskState } from "../components/ui";
import type { AiTask, DesignDirectionsPayload, Versioned } from "../lib/api";

const thumbs = ["ph-wood", "ph-green", "ph-cloth"];

export function DirectionsScreen({
  task,
  directions,
  sharedFacts,
  error,
  saving,
  onRetry,
  onSave,
}: {
  task?: AiTask;
  directions?: Versioned<DesignDirectionsPayload>;
  sharedFacts: string;
  error?: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (payload: DesignDirectionsPayload, status: "draft" | "confirmed") => Promise<void>;
}) {
  const [draft, setDraft] = useState<DesignDirectionsPayload>();
  useEffect(() => setDraft(directions?.payload), [directions?.artifactId, directions?.payload]);

  if ((task && ["pending", "running"].includes(task.status)) || (!task && !directions)) {
    return <TaskState title="正在生成设计方向集" detail="基于已确认的项目事实，一次生成三个可横向比较的方向卡。" />;
  }
  if (task?.status === "failed" || !draft) {
    return (
      <TaskState error title="设计方向集未生成"
        detail={task?.error_message || error || "暂时无法生成设计方向。"}
        action={<button type="button" className="btn primary" onClick={onRetry}>重新生成 →</button>} />
    );
  }

  const confirmed = directions?.status === "confirmed";
  const select = (id: string) => {
    if (!confirmed) setDraft((c) => c && { ...c, selected_direction_id: id });
  };

  return (
    <div className="page">
      <p className="eyebrow">设计方向集 · 一次生成 · 横向比较</p>
      <h1 className="h-display">三个方向，一套事实</h1>
      <p className="lede">方向卡不是效果图，是可比较的设计概念。三张卡共享已确认的项目事实，在空间组织策略与关键取舍上明确不同。</p>

      <div className="shared-facts">
        <Badge tone="ok">共享事实基线</Badge>
        <span>{sharedFacts || "已确认的项目事实将显示在这里"}</span>
      </div>
      {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}

      <div className="dir-grid">
        {draft.cards.map((card, index) => {
          const selected = draft.selected_direction_id === card.direction_id;
          return (
            <article className={`dir-card ${selected ? "selected" : ""}`} key={card.direction_id}>
              <div className="dir-thumb">
                <div className={`ph ${thumbs[index % thumbs.length]}`} data-ph="效果图占位" style={{ position: "absolute", inset: 0 }} role="img" aria-label={`${card.title} 方向效果图占位`} />
                <span className="id">{card.direction_id.toUpperCase()}</span>
              </div>
              <div className="dir-body">
                <div>
                  <h2 className="h-section">{card.title}</h2>
                  <p className="dir-concept">{card.concept}</p>
                </div>
                <DirectionList k="空间策略" items={card.spatial_strategies} />
                <DirectionList k="关键取舍" items={card.key_tradeoffs} tradeoff />
                <div className="dir-sec">
                  <div className="k">材料与色彩</div>
                  <div className="chips">{card.materials_and_colors.map((m) => <span className="chip" key={m}>{m}</span>)}</div>
                </div>
                <DirectionList k="差异点" items={card.distinctions} />
                <div className="dir-foot">
                  {selected ? <Badge tone="hard">已选方向</Badge> : <Badge tone="tbc">待比较</Badge>}
                  {!confirmed && (
                    <button type="button" className={`btn ${selected ? "primary" : "secondary"}`} onClick={() => select(card.direction_id)}>
                      {selected ? "已选择" : "选此方向"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {confirmed ? (
        <GateBar note="方向选择已确认。方案约束包（8 模块）基于此方向生成。">
          <Seal>✓ 方向已确认{draft.selected_direction_id ? ` · ${draft.selected_direction_id.toUpperCase()}` : ""}</Seal>
        </GateBar>
      ) : (
        <GateBar note={draft.selected_direction_id ? "确认后生成该方向的方案约束包。" : "先选择一个方向，再确认。"}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn secondary" disabled={saving} onClick={() => onSave(draft, "draft")}>保存草稿</button>
            <button type="button" className="btn primary" disabled={saving || !draft.selected_direction_id} data-state={saving ? "loading" : undefined} onClick={() => onSave(draft, "confirmed")}>
              {saving ? <><Spinner /> 正在确认…</> : "确认方向选择 →"}
            </button>
          </div>
        </GateBar>
      )}
    </div>
  );
}

function DirectionList({ k, items, tradeoff }: { k: string; items: string[]; tradeoff?: boolean }) {
  return (
    <div className={`dir-sec ${tradeoff ? "tradeoff" : ""}`}>
      <div className="k">{k}</div>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}
