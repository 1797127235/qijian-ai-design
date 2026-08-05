import { useRef, useState } from "react";
import { api } from "../lib/api";
import { FloorPlanPreview } from "./FloorPlanPreview";
import type { Space } from "./types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function SpaceMapSetup({
  projectId,
  initialFileId,
  existingSpaces,
  onSave,
  onCancel,
}: {
  projectId: string;
  initialFileId?: string;
  existingSpaces?: Space[];
  onSave: (payload: { source_file_id: string; spaces: Space[] }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [fileId, setFileId] = useState(initialFileId);
  const [fileName, setFileName] = useState<string>();
  const [spaces, setSpaces] = useState<Space[]>(existingSpaces ?? []);
  const [draw, setDraw] = useState<{ x: number; y: number; w: number; h: number }>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number }>();

  const upload = async (file: File) => {
    setUploading(true);
    setError(undefined);
    try {
      const stored = await api.uploadFile(projectId, file);
      setFileId(stored.id);
      setFileName(stored.originalFilename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const norm = (e: React.PointerEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".region")) return;
    const p = norm(e);
    dragStart.current = p;
    setDraw({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const p = norm(e);
    const s = dragStart.current;
    setDraw({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onPointerUp = () => {
    dragStart.current = undefined;
    if (draw && draw.w * draw.h >= 0.0004) {
      setSpaces((cur) => [...cur, { id: `space-${Date.now().toString(36)}`, name: `空间 ${cur.length + 1}`, key: cur.length === 0, ...draw }]);
    }
    setDraw(undefined);
  };

  const save = async () => {
    if (!fileId) {
      setError("请先上传户型图纸。");
      return;
    }
    if (spaces.length === 0) {
      setError("请先在图纸上拖出至少一个空间区域。");
      return;
    }
    if (!spaces.some((s) => s.key)) {
      setError("请至少标记一个关键空间（★）。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave({ source_file_id: fileId, spaces });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      setSaving(false);
    }
  };

  return (
    <div className="smap-card obj">
      <div className="smap-head">
        <span className="who">空间地图 · 第 1 步</span>
        {onCancel && <button type="button" className="mini-btn" onClick={onCancel}>取消</button>}
      </div>
      {!fileId ? (
        <label className="smap-upload">
          <input
            type="file"
            accept="image/png,image/jpeg,application/pdf"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {uploading ? "上传中…" : "＋ 上传户型图纸（PNG / JPG / PDF）"}
          {fileName && <span className="dim">{fileName}</span>}
        </label>
      ) : (
        <>
          <div
            ref={stageRef}
            className="smap-stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <FloorPlanPreview fileId={fileId} />
            {spaces.map((s) => (
              <div
                key={s.id}
                className={`region ${s.key ? "key" : ""}`}
                style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }}
              >
                {s.name}{s.key ? " ★" : ""}
              </div>
            ))}
            {draw && (
              <div
                className="smap-draw"
                style={{ left: `${draw.x * 100}%`, top: `${draw.y * 100}%`, width: `${draw.w * 100}%`, height: `${draw.h * 100}%` }}
              />
            )}
          </div>
          <div className="smap-list">
            {spaces.map((s) => (
              <div className="smap-row" key={s.id}>
                <input
                  className="smap-name"
                  value={s.name}
                  onChange={(e) => setSpaces((cur) => cur.map((it) => (it.id === s.id ? { ...it, name: e.target.value } : it)))}
                />
                <button
                  type="button"
                  className={`mini-btn ${s.key ? "primary" : ""}`}
                  onClick={() => setSpaces((cur) => cur.map((it) => (it.id === s.id ? { ...it, key: !it.key } : it)))}
                >
                  {s.key ? "★ 关键" : "☆"}
                </button>
                <button type="button" className="mini-btn" onClick={() => setSpaces((cur) => cur.filter((it) => it.id !== s.id))}>删</button>
              </div>
            ))}
            {spaces.length === 0 && <p className="dim">在图纸上按住拖动，框出第一个空间。</p>}
          </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      {fileId && (
        <button type="button" className="mini-btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存空间地图草稿 →"}
        </button>
      )}
    </div>
  );
}
