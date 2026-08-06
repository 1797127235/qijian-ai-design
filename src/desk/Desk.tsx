import { useEffect, useRef, useState, type ReactNode } from "react";
import { positionFromPointer, screenToWorld, zoomAtPoint, type Viewport } from "./geometry";
import type { DeskObject } from "./types";

export function Desk({
  objects,
  onMove,
  onMoveEnd,
  initialViewport,
  onViewportChange,
  focusRequest,
  selectedId,
  onSelect,
  onDropFiles,
  onDeleteObject,
  renderObject,
  overlay,
  children,
}: {
  objects: DeskObject[];
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd?: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => void;
  initialViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  focusRequest?: { id: string; token: number };
  selectedId?: string;
  onSelect?: (id?: string) => void;
  onDropFiles?: (files: File[]) => void;
  onDeleteObject?: (id: string) => void;
  renderObject: (obj: DeskObject) => ReactNode;
  overlay?: ReactNode;
  children?: ReactNode;
}) {
  const [view, setView] = useState<Viewport>(initialViewport ?? { x: 40, y: 20, zoom: 0.62 });
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number }>();
  const drag = useRef<{ id: string; ox: number; oy: number }>();
  const dragStart = useRef<{ id: string; x: number; y: number }>();
  const lastDragPos = useRef<{ id: string; x: number; y: number }>();
  const vpRef = useRef<HTMLDivElement>(null);
  const handledFocusToken = useRef<number>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();

  useEffect(() => {
    if (initialViewport) setView(initialViewport);
  }, [initialViewport?.x, initialViewport?.y, initialViewport?.zoom]);

  useEffect(() => {
    onViewportChange?.(view);
  }, [onViewportChange, view]);

  useEffect(() => {
    if (!focusRequest) return;
    if (handledFocusToken.current === focusRequest.token) return;
    const object = objects.find((item) => item.id === focusRequest.id);
    const rect = vpRef.current?.getBoundingClientRect();
    if (!object || !rect) return;
    handledFocusToken.current = focusRequest.token;
    const width = object.kind === "direction_set" ? 780 : 230;
    const height = object.kind === "direction_set" ? 300 : 220;
    setView((current) => ({
      ...current,
      x: rect.width / 2 - (object.x + width / 2) * current.zoom,
      y: rect.height / 2 - (object.y + height / 2) * current.zoom,
    }));
  }, [focusRequest, objects]);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(undefined);
    if ((e.target as HTMLElement).closest(".obj, button, input, textarea, select, a")) return;
    onSelect?.(undefined);
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const movePointer = (e: React.PointerEvent) => {
    if (drag.current) {
      const { id, ox, oy } = drag.current;
      const rect = vpRef.current!.getBoundingClientRect();
      const pointer = screenToWorld({ x: e.clientX, y: e.clientY }, { x: rect.left, y: rect.top }, view);
      const { x, y } = positionFromPointer(pointer, { x: ox, y: oy });
      lastDragPos.current = { id, x, y };
      onMove(id, x, y);
      return;
    }
    if (!pan.current) return;
    setView((v) => ({ ...v, x: pan.current!.vx + e.clientX - pan.current!.sx, y: pan.current!.vy + e.clientY - pan.current!.sy }));
  };
  const endPointer = () => {
    pan.current = undefined;
    if (drag.current && lastDragPos.current && dragStart.current) {
      onMoveEnd?.(lastDragPos.current.id, { x: dragStart.current.x, y: dragStart.current.y }, { x: lastDragPos.current.x, y: lastDragPos.current.y });
    }
    drag.current = undefined;
    dragStart.current = undefined;
    lastDragPos.current = undefined;
    setPanning(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const d = e.deltaY < 0 ? 1.08 : 0.92;
    setView((v) => {
      const z = Math.min(1.6, Math.max(0.3, v.zoom * d));
      const rect = vpRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      return zoomAtPoint(v, { x: cx, y: cy }, z);
    });
  };

  const startNodeDrag = (e: React.PointerEvent, obj: DeskObject) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
    setMenu(undefined);
    e.stopPropagation();
    onSelect?.(obj.id);
    const rect = vpRef.current!.getBoundingClientRect();
    const pointer = screenToWorld({ x: e.clientX, y: e.clientY }, { x: rect.left, y: rect.top }, view);
    drag.current = { id: obj.id, ox: pointer.x - obj.x, oy: pointer.y - obj.y };
    dragStart.current = { id: obj.id, x: obj.x, y: obj.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const openContextMenu = (e: React.MouseEvent, obj: DeskObject) => {
    if (!onDeleteObject) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect?.(obj.id);
    const rect = vpRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ id: obj.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onDrop = (e: React.DragEvent) => {
    if (!onDropFiles || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    onDropFiles(Array.from(e.dataTransfer.files));
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
      onDragOver={(e) => {
        if (onDropFiles) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="desk-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        {objects.map((obj) => (
          <div
            key={`${obj.id}-${focusRequest?.id === obj.id ? focusRequest.token : "idle"}`}
            className={`obj obj-${obj.kind} ${focusRequest?.id === obj.id ? "obj-focused" : ""} ${selectedId === obj.id ? "obj-selected" : ""}`}
            style={{ left: obj.x, top: obj.y, transform: `rotate(${obj.rot}deg)` }}
            onPointerDown={(e) => startNodeDrag(e, obj)}
            onContextMenu={(e) => openContextMenu(e, obj)}
          >
            {renderObject(obj)}
          </div>
        ))}
        {children}
      </div>
      <div className="desk-tools">
        <button type="button" aria-label="放大" onClick={() => setView((v) => ({ ...v, zoom: Math.min(1.6, v.zoom + 0.1) }))}>＋</button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button type="button" aria-label="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.3, v.zoom - 0.1) }))}>−</button>
        <button type="button" onClick={() => setView({ x: 40, y: 20, zoom: 0.62 })}>复位</button>
      </div>
      <p className="desk-hint">拖动空白平移 · 滚轮缩放 · 拖动物件摆放 · 右键删除 · Ctrl+Z 撤销</p>
      {overlay}
      {menu && (
        <div className="desk-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            onClick={() => {
              onDeleteObject?.(menu.id);
              setMenu(undefined);
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
