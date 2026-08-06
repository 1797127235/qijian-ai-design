import { useState } from "react";
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
  const [prompt, setPrompt] = useState(source.kind === "sticky_note" ? source.text : source.kind === "effect_image" ? (source.prompt ?? "") : "");
  const canSubmit = prompt.trim().length > 0 || source.kind === "canvas_image" || source.kind === "effect_image";
  return (
    <div
      className="desk-prompt-panel"
      style={{ left: source.x, top: source.y + 170 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="desk-prompt-refs">
        {references.length === 0 ? (
          <span className="mute">拖线可添加参考</span>
        ) : (
          references.map((ref) => (
            <span key={ref.id} className="desk-prompt-chip">
              {ref.kind === "sticky_note" ? (ref.text || "便签") : "图"}
            </span>
          ))
        )}
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想生成的效果…"
        rows={3}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit && !busy) onGenerate(prompt);
          }
        }}
      />
      <div className="desk-prompt-actions">
        <button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="primary" disabled={!canSubmit || busy} onClick={() => onGenerate(prompt)}>
          {busy ? "生成中…" : "生成"}
        </button>
      </div>
    </div>
  );
}
