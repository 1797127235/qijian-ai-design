import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Settings2 } from "lucide-react";
import { api } from "../lib/api";
import { nodeSize } from "./connection-geometry";
import { IMAGE_SIZE_OPTIONS, sizeSummaryLabel } from "./image-size-options";
import type { DeskObject } from "./types";

const PANEL_W = 340;

function shortModel(id: string) {
  if (id.length <= 18) return id;
  return `${id.slice(0, 16)}…`;
}

type ModelChoice = { id: string; providerId: string; providerLabel: string };

function choiceLabel(c: ModelChoice) {
  return c.providerLabel ? `${c.id} · ${c.providerLabel}` : c.id;
}

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
  onGenerate: (prompt: string, opts?: { size?: string; model?: string }) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(() => initialPrompt(source));
  const [size, setSize] = useState("auto");
  const [model, setModel] = useState<string>("");
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const barLeftRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPrompt(initialPrompt(source));
  }, [source.id]);

  useEffect(() => {
    let cancelled = false;
    void api.publicConfig().then((cfg) => {
      if (cancelled) return;
      const ids = cfg.imageModels?.length
        ? cfg.imageModels
        : cfg.imageModel
          ? [cfg.imageModel]
          : [];
      const next = cfg.imageModelChoices?.length
        ? cfg.imageModelChoices
        : ids.map((id) => ({ id, providerId: "primary", providerLabel: "" }));
      setChoices(next);
      setModel((cur) => cur || cfg.imageModel || next[0]?.id || "");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settingsOpen && !modelOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (barLeftRef.current?.contains(e.target)) return;
      setSettingsOpen(false);
      setModelOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [settingsOpen, modelOpen]);

  const sourceHasImage = Boolean(source.url);
  const canSubmit = prompt.trim().length > 0 || sourceHasImage;
  const dim = nodeSize(source);
  const top = source.y + dim.h + 14;
  const left = source.x + (dim.w - PANEL_W) / 2;

  const submit = () => {
    if (!canSubmit || busy) return;
    onGenerate(prompt, {
      size: size === "auto" ? undefined : size,
      model: model || undefined,
    });
  };

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
            <span key={ref.id} className="desk-prompt-chip">
              参考图
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
            submit();
          }
        }}
      />
      <div className="desk-prompt-bar">
        <div className="desk-prompt-bar-left" ref={barLeftRef}>
          {choices.length > 0 && (
            <div className="desk-prompt-model-wrap">
              <button
                type="button"
                className="desk-prompt-model"
                disabled={busy}
                aria-expanded={modelOpen}
                aria-haspopup="listbox"
                title={choiceLabel(choices.find((c) => c.id === model) ?? { id: model || choices[0]?.id || "", providerId: "", providerLabel: "" })}
                onClick={() => {
                  setModelOpen((o) => !o);
                  setSettingsOpen(false);
                }}
              >
                <span className="desk-prompt-model-label">{shortModel(model || choices[0]?.id || "")}</span>
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>
              {modelOpen && (
                <div className="desk-prompt-model-pop" role="listbox" aria-label="生图模型">
                  {choices.map((c) => (
                    <button
                      key={`${c.providerId}:${c.id}`}
                      type="button"
                      role="option"
                      aria-selected={c.id === model}
                      className={c.id === model ? "selected" : undefined}
                      onClick={() => {
                        setModel(c.id);
                        setModelOpen(false);
                      }}
                    >
                      <span className="desk-prompt-model-id">{c.id}</span>
                      {c.providerLabel ? <span className="desk-prompt-model-provider">{c.providerLabel}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="desk-prompt-settings-wrap">
            <button
              type="button"
              className="desk-prompt-settings"
              disabled={busy}
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setSettingsOpen((o) => !o);
                setModelOpen(false);
              }}
            >
              <Settings2 size={14} strokeWidth={1.75} />
              <span className="desk-prompt-settings-label">{sizeSummaryLabel(size)}</span>
            </button>
            {settingsOpen && (
              <div className="desk-prompt-settings-pop" role="dialog" aria-label="图像尺寸">
                <div className="desk-prompt-settings-title">比例</div>
                <div className="desk-prompt-size-grid">
                  {IMAGE_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={size === opt.value ? "selected" : undefined}
                      onClick={() => {
                        setSize(opt.value);
                        setSettingsOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          className={`desk-prompt-send${busy ? " busy" : ""}`}
          disabled={!canSubmit || busy}
          aria-label={busy ? "生成中" : "生成"}
          onClick={submit}
        >
          <ArrowUp size={18} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

function initialPrompt(source: DeskObject) {
  return source.userPrompt ?? source.prompt ?? "";
}
