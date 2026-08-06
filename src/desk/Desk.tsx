import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionsLayer } from "./Connections";
import { nodeSize, sourceAnchor, targetAnchor } from "./connection-geometry";
import { positionFromPointer, screenToWorld, zoomAtPoint, type Viewport } from "./geometry";
import type { DeskConnection, DeskObject } from "./types";

export function Desk({
  objects,
  connections = [],
  onMove,
  onMoveEnd,
  initialViewport,
  onViewportChange,
  focusRequest,
  selectedId,
  selectedConnectionId,
  onSelect,
  onSelectConnection,
  onDropFiles,
  onDeleteObject,
  onCreateConnection,
  onDeleteConnection,
  renderObject,
  overlay,
  children,
}: {
  objects: DeskObject[];
  connections?: DeskConnection[];
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd?: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => void;
  initialViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  focusRequest?: { id: string; token: number };
  selectedId?: string;
  selectedConnectionId?: string;
  /** panel:false 时只选中不打开提示词面板（右键删除用） */
  onSelect?: (id?: string, opts?: { panel?: boolean }) => void;
  onSelectConnection?: (id?: string) => void;
  onDropFiles?: (files: File[]) => void;
  onDeleteObject?: (id: string) => void;
  onCreateConnection?: (from: string, to: string) => void;
  onDeleteConnection?: (id: string) => void;
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
  const connect = useRef<{ fromId: string; x: number; y: number }>();
  const pendingClick = useRef<{ id: string; x: number; y: number }>();
  const [preview, setPreview] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  const vpRef = useRef<HTMLDivElement>(null);
  const handledFocusToken = useRef<number>();
  const [menu, setMenu] = useState<{ kind: "object" | "connection"; id: string; x: number; y: number }>();

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
    const size = nodeSize(object);
    setView((current) => ({
      ...current,
      x: rect.width / 2 - (object.x + size.w / 2) * current.zoom,
      y: rect.height / 2 - (object.y + size.h / 2) * current.zoom,
    }));
  }, [focusRequest, objects]);

  const worldFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = vpRef.current!.getBoundingClientRect();
    return screenToWorld({ x: e.clientX, y: e.clientY }, { x: rect.left, y: rect.top }, view);
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".obj, button, input, textarea, select, a, .conn-handle, .desk-prompt-panel")) return;
    setMenu(undefined);
    onSelect?.(undefined);
    onSelectConnection?.(undefined);
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const movePointer = (e: React.PointerEvent) => {
    if (connect.current) {
      const p = worldFromEvent(e);
      setPreview({ x1: connect.current.x, y1: connect.current.y, x2: p.x, y2: p.y });
      return;
    }
    // 点击阈值：移动超过 4px 才进入拖动物件
    if (pendingClick.current && !drag.current) {
      const dx = e.clientX - pendingClick.current.x;
      const dy = e.clientY - pendingClick.current.y;
      if (dx * dx + dy * dy > 16) {
        const obj = objects.find((item) => item.id === pendingClick.current!.id);
        if (obj) {
          onSelect?.(obj.id, { panel: false });
          onSelectConnection?.(undefined);
          const pointer = worldFromEvent(e);
          drag.current = { id: obj.id, ox: pointer.x - obj.x, oy: pointer.y - obj.y };
          dragStart.current = { id: obj.id, x: obj.x, y: obj.y };
        }
        pendingClick.current = undefined;
      }
    }
    if (drag.current) {
      const { id, ox, oy } = drag.current;
      const pointer = worldFromEvent(e);
      const { x, y } = positionFromPointer(pointer, { x: ox, y: oy });
      lastDragPos.current = { id, x, y };
      onMove(id, x, y);
      return;
    }
    if (!pan.current) return;
    setView((v) => ({ ...v, x: pan.current!.vx + e.clientX - pan.current!.sx, y: pan.current!.vy + e.clientY - pan.current!.sy }));
  };

  const endPointer = (e?: React.PointerEvent) => {
    if (connect.current && e) {
      const p = worldFromEvent(e);
      const target = objects.find((obj) => {
        if (obj.id === connect.current!.fromId) return false;
        const size = nodeSize(obj);
        return p.x >= obj.x - 12 && p.x <= obj.x + size.w + 12 && p.y >= obj.y - 12 && p.y <= obj.y + size.h + 12;
      });
      if (target) onCreateConnection?.(connect.current.fromId, target.id);
      connect.current = undefined;
      setPreview(undefined);
    }
    // 纯点击：选中并打开提示词面板
    if (pendingClick.current && !drag.current) {
      onSelect?.(pendingClick.current.id, { panel: true });
      onSelectConnection?.(undefined);
    }
    pendingClick.current = undefined;
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
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .conn-handle")) return;
    setMenu(undefined);
    e.stopPropagation();
    // 先记下点击；真正拖动在 move 超过阈值后开始，避免「点一下」被当成拖
    pendingClick.current = { id: obj.id, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const startConnect = (e: React.PointerEvent, obj: DeskObject) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const a = sourceAnchor(obj);
    connect.current = { fromId: obj.id, x: a.x, y: a.y };
    setPreview({ x1: a.x, y1: a.y, x2: a.x, y2: a.y });
    (vpRef.current as HTMLElement).setPointerCapture(e.pointerId);
  };

  const openObjectMenu = (e: React.MouseEvent, obj: DeskObject) => {
    if (!onDeleteObject) return;
    e.preventDefault();
    e.stopPropagation();
    // 右键：只选中 + 删除菜单，不打开提示词面板
    onSelect?.(obj.id, { panel: false });
    onSelectConnection?.(undefined);
    const rect = vpRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ kind: "object", id: obj.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const openConnectionMenu = (id: string, e: React.MouseEvent) => {
    if (!onDeleteConnection) return;
    onSelectConnection?.(id);
    const rect = vpRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ kind: "connection", id, x: e.clientX - rect.left, y: e.clientY - rect.top });
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
      onPointerUp={(e) => endPointer(e)}
      onPointerCancel={() => endPointer()}
      onWheel={onWheel}
      onDragOver={(e) => {
        if (onDropFiles) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="desk-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <ConnectionsLayer
          objects={objects}
          connections={connections}
          selectedId={selectedConnectionId}
          preview={preview}
          onSelect={(id) => {
            onSelectConnection?.(id);
            onSelect?.(undefined);
          }}
          onContextMenu={openConnectionMenu}
        />
        {objects.map((obj) => {
          const size = nodeSize(obj);
          const showHandles = selectedId === obj.id || Boolean(connect.current);
          return (
            <div
              key={`${obj.id}-${focusRequest?.id === obj.id ? focusRequest.token : "idle"}`}
              className={`obj obj-${obj.kind} ${focusRequest?.id === obj.id ? "obj-focused" : ""} ${selectedId === obj.id ? "obj-selected" : ""}`}
              style={{ left: obj.x, top: obj.y, transform: `rotate(${obj.rot}deg)` }}
              onPointerDown={(e) => startNodeDrag(e, obj)}
              onContextMenu={(e) => openObjectMenu(e, obj)}
            >
              {renderObject(obj)}
              {showHandles && onCreateConnection && (
                <>
                  <span className="conn-handle conn-handle-target" style={{ left: -5, top: size.h / 2 - 5 }} title="连入" />
                  <span
                    className="conn-handle conn-handle-source"
                    style={{ left: size.w - 5, top: size.h / 2 - 5 }}
                    title="拖出连线"
                    onPointerDown={(e) => startConnect(e, obj)}
                  />
                </>
              )}
            </div>
          );
        })}
        {children}
      </div>
      <div className="desk-tools">
        <button type="button" aria-label="放大" onClick={() => setView((v) => ({ ...v, zoom: Math.min(1.6, v.zoom + 0.1) }))}>＋</button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button type="button" aria-label="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.3, v.zoom - 0.1) }))}>−</button>
        <button type="button" onClick={() => setView({ x: 40, y: 20, zoom: 0.62 })}>复位</button>
      </div>
      {overlay}
      {menu && (
        <div className="desk-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            onClick={() => {
              if (menu.kind === "object") onDeleteObject?.(menu.id);
              else onDeleteConnection?.(menu.id);
              setMenu(undefined);
            }}
          >
            {menu.kind === "object" ? "删除" : "删除连线"}
          </button>
        </div>
      )}
    </div>
  );
}
