import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeskObject } from "./types";

interface Viewport { x: number; y: number; zoom: number }

export function Desk({
  objects,
  onMove,
  onMoveEnd,
  initialViewport,
  onViewportChange,
  renderObject,
}: {
  objects: DeskObject[];
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd?: (id: string, x: number, y: number) => void;
  initialViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  renderObject: (obj: DeskObject) => ReactNode;
}) {
  const [view, setView] = useState<Viewport>(initialViewport ?? { x: 40, y: 20, zoom: 0.62 });
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number }>();
  const drag = useRef<{ id: string; ox: number; oy: number }>();
  const lastDragPos = useRef<{ id: string; x: number; y: number }>();
  const vpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialViewport) setView(initialViewport);
  }, [initialViewport?.x, initialViewport?.y, initialViewport?.zoom]);

  useEffect(() => {
    onViewportChange?.(view);
  }, [onViewportChange, view]);

  const startPan = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".obj")) return;
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const movePointer = (e: React.PointerEvent) => {
    if (drag.current) {
      const { id, ox, oy } = drag.current;
      const rect = vpRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left - view.x) / view.zoom - ox;
      const y = (e.clientY - rect.top - view.y) / view.zoom - oy;
      lastDragPos.current = { id, x, y };
      onMove(id, x, y);
      return;
    }
    if (!pan.current) return;
    setView((v) => ({ ...v, x: pan.current!.vx + e.clientX - pan.current!.sx, y: pan.current!.vy + e.clientY - pan.current!.sy }));
  };
  const endPointer = () => {
    pan.current = undefined;
    if (drag.current && lastDragPos.current) onMoveEnd?.(lastDragPos.current.id, lastDragPos.current.x, lastDragPos.current.y);
    drag.current = undefined;
    lastDragPos.current = undefined;
    setPanning(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    const d = e.deltaY < 0 ? 1.08 : 0.92;
    setView((v) => {
      const z = Math.min(1.6, Math.max(0.3, v.zoom * d));
      const rect = vpRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      return { x: cx - (cx - v.x) * (z / v.zoom), y: cy - (cy - v.y) * (z / v.zoom), zoom: z };
    });
  };

  const startNodeDrag = (e: React.PointerEvent, obj: DeskObject) => {
    if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
    e.stopPropagation();
    drag.current = { id: obj.id, ox: 0, oy: 0 };
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drag.current.ox = (e.clientX - rect.left) / view.zoom;
    drag.current.oy = (e.clientY - rect.top) / view.zoom;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  return (
    <div
      ref={vpRef}
      className={`desk ${panning ? "panning" : ""}`}
      onPointerDown={startPan}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={onWheel}
    >
      <div className="desk-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        {objects.map((obj) => (
          <div
            key={obj.id}
            className={`obj obj-${obj.kind}`}
            style={{ left: obj.x, top: obj.y, transform: `rotate(${obj.rot}deg)` }}
            onPointerDown={(e) => startNodeDrag(e, obj)}
          >
            {renderObject(obj)}
          </div>
        ))}
      </div>
      <div className="desk-tools">
        <button type="button" aria-label="放大" onClick={() => setView((v) => ({ ...v, zoom: Math.min(1.6, v.zoom + 0.1) }))}>＋</button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button type="button" aria-label="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.3, v.zoom - 0.1) }))}>−</button>
        <button type="button" onClick={() => setView({ x: 40, y: 20, zoom: 0.62 })}>复位</button>
      </div>
      <p className="desk-hint">拖动空白平移 · 滚轮缩放 · 拖动物件摆放</p>
    </div>
  );
}
