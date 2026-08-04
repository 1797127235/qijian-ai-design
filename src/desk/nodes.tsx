import { useEffect, useState } from "react";
import { FloorPlanPreview } from "./FloorPlanPreview";
import type { DeskObject } from "./types";

export interface Handlers {
  onConfirm: (artifactId: string) => void;
  onSelectDirection: (artifactId: string, directionId: string) => void;
  onAdopt: (artifactId: string, adopted: boolean) => void;
  onSaveBrief: (artifactId: string, text: string) => Promise<boolean>;
  onRedrawPlan: (artifactId: string) => void;
}

function BriefCard({ obj, handlers }: { obj: Extract<DeskObject, { kind: "brief" }>; handlers: Handlers }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(obj.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!editing) setText(obj.text);
  }, [editing, obj.text]);

  if (editing) {
    return (
      <div className="note-card brief-card">
        <span className="pin" />
        <span className="who">客户说 · Brief · 修改中</span>
        <textarea className="brief-edit" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="mini-btn" onClick={() => { setText(obj.text); setEditing(false); }}>取消</button>
          <button
            type="button"
            className="mini-btn primary"
            disabled={saving || !text.trim()}
            onClick={() => {
              setSaving(true);
              setError(undefined);
              void handlers.onSaveBrief(obj.id, text.trim()).then((saved) => {
                if (saved) setEditing(false);
                else setError("Brief 未保存，请重试");
              }).finally(() => setSaving(false));
            }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="note-card brief-card">
      <span className="pin" />
      <span className="who">客户说 · Brief</span>
      <p>{obj.text}</p>
      {obj.files.length > 0 && <div className="chips">{obj.files.map((f) => <span className="chip" key={f}>{f}</span>)}</div>}
      {obj.status === "confirmed"
        ? <span className="stamp">✓ Brief 已确认</span>
        : (
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="mini-btn" onClick={() => setEditing(true)}>修改</button>
            <button type="button" className="mini-btn primary" onClick={() => handlers.onConfirm(obj.id)}>确认 Brief</button>
          </div>
        )}
    </div>
  );
}

export function DeskObjectView({ obj, handlers }: { obj: DeskObject; handlers: Handlers }) {
  switch (obj.kind) {
    case "brief":
      return <BriefCard obj={obj} handlers={handlers} />;

    case "plan":
      return (
        <div className="plan" style={{ width: obj.w }}>
          <span className="plan-tag">空间地图 {obj.status === "confirmed" ? "· 已确认 ✓" : "· 草稿"}</span>
          <div className="plan-media">
            {obj.sourceFileId
              ? <FloorPlanPreview fileId={obj.sourceFileId} alt="户型图" />
              : <div className="plan-empty">无图纸</div>}
            {obj.spaces.map((s) => (
              <div
                key={s.id}
                className={`region ${s.key ? "key" : ""}`}
                style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }}
              >
                {s.name}{s.key ? " ★" : ""}
              </div>
            ))}
          </div>
          {obj.status !== "confirmed" && (
            <div className="plan-actions">
              <button type="button" className="mini-btn" onClick={() => handlers.onRedrawPlan(obj.id)}>重新绘制</button>
              <button type="button" className="mini-btn primary" onClick={() => handlers.onConfirm(obj.id)}>确认空间地图 →</button>
            </div>
          )}
        </div>
      );

    case "note":
      return (
        <div className={`note-card ai-note ${obj.status === "confirmed" ? "confirmed" : ""}`}>
          <span className="who">{obj.who}{obj.status === "confirmed" ? " · 已确认 ✓" : ""}</span>
          <p>{obj.text}</p>
          {obj.status !== "confirmed" && (
            <button type="button" className="mini-btn" onClick={() => handlers.onConfirm(obj.id)}>确认</button>
          )}
        </div>
      );

    case "direction_set":
      return (
        <div className="dir-set">
          {obj.directions.map((d, i) => {
            const selected = obj.selectedId === d.id;
            const confirmed = obj.status === "confirmed";
            return (
              <div className={`dir-card ${selected ? "selected" : ""}`} key={d.id}>
                {selected && confirmed && <span className="pin" />}
                <div className="dir-head">
                  <span className="who">方向 {String.fromCharCode(65 + i)}</span>
                  <span className={`tag ${selected ? "acc" : "tbc"}`}>{selected ? (confirmed ? "已选定" : "已选 · 待确认") : "待比较"}</span>
                </div>
                <div className={`ph ph-${d.tone ?? "wood"}`} style={{ height: 84 }} />
                <h3>{d.title}</h3>
                <p>{d.concept}</p>
                {d.chips.length > 0 && <div className="chips">{d.chips.map((c) => <span className="chip" key={c}>{c}</span>)}</div>}
                {selected && confirmed && <span className="stamp acc">✓ 方向已确认</span>}
                {!confirmed && (
                  <button
                    type="button"
                    className={`mini-btn ${selected ? "primary" : ""}`}
                    onClick={() => (selected ? handlers.onConfirm(obj.id) : handlers.onSelectDirection(obj.id, d.id))}
                  >
                    {selected ? "确认此方向" : "选此方向"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      );

    case "effect_image":
      return (
        <div className={`photo fx-single ${obj.adopted ? "adopted" : ""}`} style={{ width: 170 }}>
          {obj.adopted && <span className="pin" />}
          <img src={obj.url} alt="效果图变体" draggable={false} style={{ width: "100%", borderRadius: 2, display: "block" }} />
          <span className="cap">效果图{obj.adopted ? " · 已采用 ✓" : ""}</span>
          {!obj.adopted && (
            <div className="fx-actions">
              <button type="button" className="mini-btn" onClick={() => handlers.onAdopt(obj.id, true)}>采用</button>
            </div>
          )}
        </div>
      );

    case "setup":
      return null;
  }
}
