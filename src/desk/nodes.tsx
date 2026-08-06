import type { DeskObject } from "./types";

/** 展示层：只呈现物件；便签编辑通过回调上抛。 */
export function DeskObjectView({
  obj,
  editing,
  onStartEdit,
  onCommitText,
  onRetryGenerate,
}: {
  obj: DeskObject;
  editing?: boolean;
  onStartEdit?: (id: string) => void;
  onCommitText?: (id: string, text: string) => void;
  onRetryGenerate?: (id: string) => void;
}) {
  switch (obj.kind) {
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
          <img
            src={obj.url}
            alt="画布图片"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            style={{ width: "100%", borderRadius: 2, display: "block", pointerEvents: "none" }}
          />
        </div>
      );

    case "effect_image":
      if (obj.pending) {
        return (
          <div className="photo fx-single effect-pending" style={{ width: 220, height: 160 }}>
            <div className="effect-spinner" />
            <span>生成中</span>
          </div>
        );
      }
      if (obj.error || !obj.url) {
        return (
          <div className="photo fx-single effect-error" style={{ width: 220, height: 160 }}>
            <span>{obj.error ?? "生成失败"}</span>
            {onRetryGenerate && (
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onRetryGenerate(obj.id)}>
                重试
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="photo fx-single" style={{ width: 220 }}>
          <img
            src={obj.url}
            alt="效果图"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            style={{ width: "100%", borderRadius: 2, display: "block", pointerEvents: "none" }}
          />
        </div>
      );
  }
}
