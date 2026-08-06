import { useEffect, useState } from "react";
import { nodeSize } from "./connection-geometry";
import type { DeskObject } from "./types";

export function PromptPanel({
  source,
  references,
  busy,
  onGenerate,
  onClose,
}: {
  source: DeskObject;
  references: DeskObject[];
  busy?: boolean;
  onGenerate: (prompt: string) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(() => initialPrompt(source));
  useEffect(() => {
    setPrompt(initialPrompt(source));
  }, [source.id]);

  const canSubmit = prompt.trim().length > 0 || source.kind === "canvas_image" || source.kind === "effect_image";
  const size = nodeSize(source);
  const top = source.y + size.h + 12;
  const left = source.x + Math.max(0, (size.w - 300) / 2);

  return (
    <div
      className="desk-prompt-panel"
      style={{ left, top, width: 300 }}
      onPointerDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="生图提示词"
    >
      {references.length > 0 && (
        <div className="desk-prompt-refs">
          {references.map((ref) => (
            <span key={ref.id} className="desk-prompt-chip" title={ref.kind === "sticky_note" ? ref.text : undefined}>
              {ref.kind === "sticky_note" ? (ref.text?.slice(0, 12) || "便签") : "参考图"}
            </span>
          ))}
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想生成的效果…"
        rows={3}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit && !busy) onGenerate(prompt);
          }
        }}
      />
      <div className="desk-prompt-bar">
        <span className="desk-prompt-meta" title="当前生图模型">
          grok-imagine-image-quality
        </span>
        <div className="desk-prompt-actions">
          {!busy && (
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          )}
          <button
            type="button"
            className={busy ? "busy" : "primary"}
            disabled={!canSubmit || busy}
            onClick={() => onGenerate(prompt)}
          >
            {busy ? "生成中" : "生成"}
          </button>
        </div>
      </div>
    </div>
  );
}

function initialPrompt(source: DeskObject) {
  if (source.kind === "sticky_note") return source.text;
  if (source.kind === "effect_image") return source.prompt ?? "";
  return "";
}
