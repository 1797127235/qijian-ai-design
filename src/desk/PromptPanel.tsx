import { useEffect, useState } from "react";
import { nodeSize } from "./connection-geometry";
import type { DeskObject } from "./types";

const PANEL_W = 280;

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

  // 有图（canvas/effect 已出图）可空 prompt 直接图生图；空占位卡与便签必须填提示词
  const sourceHasImage = (source.kind === "canvas_image" || source.kind === "effect_image") && Boolean(source.url);
  const canSubmit = prompt.trim().length > 0 || sourceHasImage;
  const size = nodeSize(source);
  const top = source.y + size.h + 14;
  
  const left = source.x + (size.w - PANEL_W) / 2;

  return (
    <div
      className="desk-prompt-panel"
      style={{ left, top, width: PANEL_W }}
      onPointerDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="生图提示词"
    >
      {references.length > 0 && (
        <div className="desk-prompt-refs">
          {references.map((ref) => (
            <span key={ref.id} className="desk-prompt-chip" title={ref.kind === "sticky_note" ? ref.text : undefined}>
              {ref.kind === "sticky_note" ? (ref.text?.slice(0, 14) || "便签") : "参考图"}
            </span>
          ))}
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={source.kind === "canvas_image" && !source.url ? "描述您要生成的图片内容…" : "描述你想生成的效果…"}
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
        <div className="desk-prompt-actions">
          <button
            type="button"
            className={busy ? "busy" : "primary"}
            disabled={!canSubmit || busy}
            onClick={() => onGenerate(prompt)}
          >
            {busy ? "生成中…" : "生成"}
          </button>
        </div>
      </div>
    </div>
  );
}

function initialPrompt(source: DeskObject) {
  if (source.kind === "sticky_note") return source.text;
  if (source.kind === "canvas_image" || source.kind === "effect_image") {
    return source.userPrompt ?? source.prompt ?? "";
  }
  return "";
}
