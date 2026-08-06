import type { DeskObject } from "./types";

/** 展示层：只呈现物件；便签编辑通过回调上抛。 */
export function DeskObjectView({
  obj,
  editing,
  onStartEdit,
  onCommitText,
}: {
  obj: DeskObject;
  editing?: boolean;
  onStartEdit?: (id: string) => void;
  onCommitText?: (id: string, text: string) => void;
}) {
  switch (obj.kind) {
    case "note":
      return (
        <div className="note-card ai-note">
          <span className="who">{obj.who}</span>
          <p>{obj.text}</p>
        </div>
      );

    case "direction_set":
      return (
        <div className="dir-set">
          {obj.directions.map((d, i) => (
            <div className="dir-card" key={d.id}>
              <div className="dir-head">
                <span className="who">方向 {String.fromCharCode(65 + i)}</span>
              </div>
              <div className={`ph ph-${d.tone ?? "wood"}`} style={{ height: 84 }} />
              <h3>{d.title}</h3>
              <p>{d.concept}</p>
              {d.chips.length > 0 && <div className="chips">{d.chips.map((c) => <span className="chip" key={c}>{c}</span>)}</div>}
            </div>
          ))}
        </div>
      );

    case "effect_image":
      return (
        <div className="photo fx-single" style={{ width: 170 }}>
          <img src={obj.url} alt="效果图" draggable={false} style={{ width: "100%", borderRadius: 2, display: "block" }} />
          <span className="cap">效果图</span>
        </div>
      );

    case "sticky_note":
      return (
        <div className="sticky-card" onDoubleClick={() => onStartEdit?.(obj.id)}>
          {editing ? (
            <textarea
              autoFocus
              defaultValue={obj.text}
              placeholder="输入文字…"
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => onCommitText?.(obj.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
          ) : obj.text ? (
            <p>{obj.text}</p>
          ) : (
            <p className="sticky-placeholder">输入文字…</p>
          )}
        </div>
      );

    case "canvas_image":
      return (
        <div className="photo fx-single" style={{ width: 220 }}>
          <img src={obj.url} alt="画布图片" draggable={false} style={{ width: "100%", borderRadius: 2, display: "block" }} />
        </div>
      );
  }
}
