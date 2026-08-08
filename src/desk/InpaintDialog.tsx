import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { api, type StoredFile } from "../lib/api";
import { CANVAS_IMAGE_ACCEPT, validateCanvasImageFile } from "./attachments";
import { normalizeRect, type InpaintRegion } from "./inpaint-geometry";
import type { DeskObject } from "./types";

type RectPx = { x: number; y: number; w: number; h: number };

/** 带图节点（局部重绘只作用于这两类，且必有 url）。 */
export type InpaintSource = Extract<DeskObject, { kind: "canvas_image" } | { kind: "effect_image" }>;

const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): RectPx => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

/**
 * 局部重绘弹窗：大图上拖拽框选区域，填 prompt 和/或上传参考图后提交。
 * 选区、prompt、参考图三者齐全才能提交（选区必填，prompt/参考图至少其一）。
 */
export function InpaintDialog({
  projectId,
  source,
  busy,
  onSubmit,
  onCancel,
}: {
  projectId: string;
  source: InpaintSource;
  busy?: boolean;
  onSubmit: (input: { prompt: string; referenceFileId?: string; region: InpaintRegion }) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<StoredFile>();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<RectPx>();
  const [region, setRegion] = useState<InpaintRegion>();
  const [confirmed, setConfirmed] = useState<RectPx>();
  const dragStart = useRef<{ x: number; y: number }>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** 弹窗内框选：client → 图片容器局部坐标（容器即图片显示尺寸）。 */
  const localFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hasContent = prompt.trim().length > 0 || Boolean(reference);
  const canSubmit = Boolean(region) && hasContent && !uploading;
  /** 按钮禁用时说明差哪一步（hint 显示在按钮旁，title 兜底 hover 提示）。 */
  let hint: string | undefined;
  if (!region) hint = "先在图片上拖出要重绘的区域";
  else if (!hasContent) hint = "再填一句描述，或上传一张参考图";
  const submit = () => {
    if (!canSubmit || busy || !region) return;
    onSubmit({ prompt: prompt.trim(), referenceFileId: reference?.id, region });
  };

  return (
    <div
      className="inpaint-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="局部重绘"
      onClick={onCancel}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="inpaint-dialog" onClick={(e) => e.stopPropagation()}>
        <div
          ref={wrapRef}
          className="inpaint-dialog-image-wrap"
          onPointerDown={(e) => {
            if (busy || e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = localFromEvent(e);
            dragStart.current = p;
            setRegion(undefined);
            setConfirmed(undefined);
            setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!dragStart.current) return;
            setDraft(rectFrom(dragStart.current, localFromEvent(e)));
          }}
          onPointerUp={(e) => {
            const start = dragStart.current;
            dragStart.current = undefined;
            setDraft(undefined);
            if (!start) return;
            const wrap = wrapRef.current!;
            const size = { w: wrap.clientWidth, h: wrap.clientHeight };
            const end = localFromEvent(e);
            const next = normalizeRect(start, end, size);
            if (!next) {
              // 单击（几乎没拖动）静默忽略；明显拖了但任一边 < 2% 给出提示，别静默吞掉
              if (Math.abs(end.x - start.x) > 3 || Math.abs(end.y - start.y) > 3) {
                setError("选区太小，往大拖一点");
              }
              return;
            }
            setError(undefined);
            setRegion(next);
            setConfirmed({ x: next.x * size.w, y: next.y * size.h, w: next.w * size.w, h: next.h * size.h });
          }}
        >
          <img src={source.url} alt="重绘源图" draggable={false} />
          {draft && (
            <div
              className="inpaint-rect"
              style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h }}
            />
          )}
          {confirmed && (
            <div
              className="inpaint-rect inpaint-rect-confirmed"
              style={{ left: confirmed.x, top: confirmed.y, width: confirmed.w, height: confirmed.h }}
            />
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="这块要变成什么样？如：换成深绿色丝绒沙发…"
          rows={3}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {reference ? (
          <div className="desk-prompt-refs">
            <span className="desk-prompt-chip inpaint-ref-chip" title={reference.originalFilename}>
              <img src={reference.url} alt="" />
              参考图
              <button
                type="button"
                aria-label="移除参考图"
                disabled={busy}
                onClick={() => setReference(undefined)}
              >
                <X size={12} />
              </button>
            </span>
          </div>
        ) : null}
        {error ? <p className="error-text">{error}</p> : null}
        {hint && !error ? <p className="inpaint-dialog-hint">{hint}</p> : null}
        <div className="desk-prompt-bar">
          <button
            type="button"
            className="inpaint-upload"
            disabled={busy || uploading}
            onClick={() => fileInputRef.current?.click()}
            title="上传参考图（可选）"
          >
            <ImagePlus size={14} strokeWidth={1.7} />
            {uploading ? "上传中…" : "参考图"}
          </button>
          <div className="desk-prompt-actions">
            <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className={busy ? "busy" : "primary"}
              disabled={!canSubmit || busy}
              onClick={submit}
              title={hint}
            >
              {busy ? "生成中…" : "重绘"}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={CANVAS_IMAGE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const problem = validateCanvasImageFile(file);
            if (problem) {
              setError(problem);
              return;
            }
            setError(undefined);
            setUploading(true);
            void api.uploadFile(projectId, file)
              .then((stored) => setReference(stored))
              .catch((err) => setError(`上传失败：${err instanceof Error ? err.message : "未知错误"}`))
              .finally(() => setUploading(false));
          }}
        />
      </div>
    </div>
  );
}
