import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionsLayer } from "./Connections";
import { nodeAabb, nodeSize, sourceAnchor } from "./connection-geometry";
import { positionFromPointer, screenToWorld, zoomAtPoint, type Viewport } from "./geometry";
import type { DeskConnection, DeskObject } from "./types";

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 5;

export type SelectOpts = { panel?: boolean; toggle?: boolean };

function aabbIntersects(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x: number; y: number; w: number; h: number },
) {
  const left = Math.min(a.x1, a.x2);
  const right = Math.max(a.x1, a.x2);
  const top = Math.min(a.y1, a.y2);
  const bottom = Math.max(a.y1, a.y2);
  return !(b.x + b.w < left || b.x > right || b.y + b.h < top || b.y > bottom);
}

export function Desk({
  objects,
  connections = [],
  onMove,
  onMoveEnd,
  initialViewport,
  onViewportChange,
  focusRequest,
  selectedIds = [],
  selectedConnectionId,
  onSelect,
  onMarqueeSelect,
  onSelectConnection,
  onDropFiles,
  onCreateConnection,
  renderObject,
  renderNodeToolbar,
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
  selectedIds?: string[];
  selectedConnectionId?: string;
  onSelect?: (id?: string, opts?: SelectOpts) => void;
  onMarqueeSelect?: (ids: string[]) => void;
  onSelectConnection?: (id?: string) => void;
  onDropFiles?: (files: File[]) => void;
  onCreateConnection?: (from: string, to: string) => void;
  renderObject: (obj: DeskObject) => ReactNode;
  /** 单选节点时渲染其上方悬浮工具条内容（按钮由调用方给）；定位/显隐由 Desk 负责 */
  renderNodeToolbar?: (obj: DeskObject) => ReactNode;
  overlay?: ReactNode;
  children?: ReactNode;
}) {
  const [view, setView] = useState<Viewport>(initialViewport ?? { x: 40, y: 20, zoom: 0.62 });
  const [panning, setPanning] = useState(false);
  const [marqueeScreen, setMarqueeScreen] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number }>();
  const marquee = useRef<{ sx: number; sy: number; wx: number; wy: number }>();
  const drag = useRef<{ id: string; ox: number; oy: number }>();
  const dragStart = useRef<{ id: string; x: number; y: number }>();
  const lastDragPos = useRef<{ id: string; x: number; y: number }>();
  const connect = useRef<{ fromId: string; x: number; y: number }>();
  const pendingClick = useRef<{ id: string; x: number; y: number; shift: boolean }>();
  const [preview, setPreview] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  const vpRef = useRef<HTMLDivElement>(null);
  const handledFocusToken = useRef<number>();
  const spaceHeld = useRef(false);

  useEffect(() => {
    if (initialViewport) {
      const clamped = { ...initialViewport, zoom: clampZoom(initialViewport.zoom) };
      setView(clamped);
      onViewportChange?.(clamped);
    }
  }, [initialViewport?.x, initialViewport?.y, initialViewport?.zoom]);

  const reportViewport = useCallback((next: Viewport) => {
    onViewportChange?.(next);
  }, [onViewportChange]);

  const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return Boolean(el.closest("input, textarea, select, [contenteditable=true]"));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
        spaceHeld.current = true;
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    const onBlur = () => { spaceHeld.current = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

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

  /** client → desk 局部坐标（框选层相对 .desk，不是视口 0,0）。 */
  const deskLocalFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = vpRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const beginPan = (e: React.PointerEvent) => {
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onViewportPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".obj, button, input, textarea, select, a, .conn-handle, .desk-prompt-panel")) return;

    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault();
      beginPan(e);
      return;
    }

    if (e.button !== 0) return;
    onSelectConnection?.(undefined);
    const world = worldFromEvent(e);
    const local = deskLocalFromEvent(e);
    marquee.current = { sx: e.clientX, sy: e.clientY, wx: world.x, wy: world.y };
    setMarqueeScreen({ x1: local.x, y1: local.y, x2: local.x, y2: local.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const movePointer = (e: React.PointerEvent) => {
    if (connect.current) {
      const p = worldFromEvent(e);
      setPreview({ x1: connect.current.x, y1: connect.current.y, x2: p.x, y2: p.y });
      return;
    }

    if (marquee.current) {
      const start = deskLocalFromEvent({ clientX: marquee.current.sx, clientY: marquee.current.sy });
      const end = deskLocalFromEvent(e);
      setMarqueeScreen({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
      return;
    }

    if (pendingClick.current && !drag.current) {
      const dx = e.clientX - pendingClick.current.x;
      const dy = e.clientY - pendingClick.current.y;
      if (dx * dx + dy * dy > 16) {
        const obj = objects.find((item) => item.id === pendingClick.current!.id);
        if (obj && !pendingClick.current.shift) {
          onSelect?.(obj.id, { panel: false });
          onSelectConnection?.(undefined);
          const pointer = worldFromEvent(e);
          drag.current = { id: obj.id, ox: pointer.x - obj.x, oy: pointer.y - obj.y };
          dragStart.current = { id: obj.id, x: obj.x, y: obj.y };
          try {
            vpRef.current?.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
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
    const panningState = pan.current;
    if (!panningState) return;
    setView((v) => {
      const next = {
        ...v,
        x: panningState.vx + e.clientX - panningState.sx,
        y: panningState.vy + e.clientY - panningState.sy,
      };
      reportViewport(next);
      return next;
    });
  };

  const finishMarquee = (e: React.PointerEvent) => {
    const m = marquee.current;
    marquee.current = undefined;
    setMarqueeScreen(undefined);
    if (!m) return;
    const dx = e.clientX - m.sx;
    const dy = e.clientY - m.sy;
    if (dx * dx + dy * dy <= 16) {
      onSelect?.(undefined);
      return;
    }
    const end = worldFromEvent(e);
    const box = { x1: m.wx, y1: m.wy, x2: end.x, y2: end.y };
    const hits = objects
      .filter((obj) => aabbIntersects(box, nodeAabb(obj)))
      .map((obj) => obj.id);
    onMarqueeSelect?.(hits);
  };

  const endPointer = (e?: React.PointerEvent) => {
    if (marquee.current && e) {
      finishMarquee(e);
    } else {
      marquee.current = undefined;
      setMarqueeScreen(undefined);
    }

    if (connect.current && e) {
      const p = worldFromEvent(e);
      const target = objects.find((obj) => {
        if (obj.id === connect.current!.fromId) return false;
        const box = nodeAabb(obj);
        return p.x >= box.x - 12 && p.x <= box.x + box.w + 12 && p.y >= box.y - 12 && p.y <= box.y + box.h + 12;
      });
      if (target) onCreateConnection?.(connect.current.fromId, target.id);
      connect.current = undefined;
      setPreview(undefined);
    }
    pendingClick.current = undefined;
    pan.current = undefined;
    if (drag.current && lastDragPos.current && dragStart.current) {
      const moved =
        Math.round(lastDragPos.current.x) !== Math.round(dragStart.current.x)
        || Math.round(lastDragPos.current.y) !== Math.round(dragStart.current.y);
      if (moved) {
        onMoveEnd?.(lastDragPos.current.id, { x: dragStart.current.x, y: dragStart.current.y }, { x: lastDragPos.current.x, y: lastDragPos.current.y });
      }
    }
    drag.current = undefined;
    dragStart.current = undefined;
    lastDragPos.current = undefined;
    setPanning(false);
  };

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = e.deltaY < 0 ? 1.08 : 0.92;
      setView((v) => {
        const z = clampZoom(v.zoom * d);
        const rect = el.getBoundingClientRect();
        const next = zoomAtPoint(v, { x: e.clientX - rect.left, y: e.clientY - rect.top }, z);
        reportViewport(next);
        return next;
      });
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("auxclick", onAuxClick);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("auxclick", onAuxClick);
    };
  }, [reportViewport]);

  const selectObject = (obj: DeskObject, opts: SelectOpts) => {
    onSelect?.(obj.id, opts);
    onSelectConnection?.(undefined);
  };

  const startNodeDrag = (e: React.PointerEvent, obj: DeskObject) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .conn-handle")) return;
    e.stopPropagation();
    const toggle = e.shiftKey;
    selectObject(obj, { panel: !toggle, toggle });
    pendingClick.current = { id: obj.id, x: e.clientX, y: e.clientY, shift: toggle };
  };

  const onObjectClick = (e: React.MouseEvent, obj: DeskObject) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .conn-handle")) return;
    e.stopPropagation();
    const toggle = e.shiftKey;
    selectObject(obj, { panel: !toggle, toggle });
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

  const onDrop = (e: React.DragEvent) => {
    if (!onDropFiles || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    onDropFiles(Array.from(e.dataTransfer.files));
  };

  const selectedSet = new Set(selectedIds);
  const toolbarObject = renderNodeToolbar && selectedIds.length === 1
    ? objects.find((o) => o.id === selectedIds[0])
    : undefined;
  const marqueeStyle = marqueeScreen
    ? {
      left: Math.min(marqueeScreen.x1, marqueeScreen.x2),
      top: Math.min(marqueeScreen.y1, marqueeScreen.y2),
      width: Math.abs(marqueeScreen.x2 - marqueeScreen.x1),
      height: Math.abs(marqueeScreen.y2 - marqueeScreen.y1),
    }
    : undefined;

  return (
    <div
      ref={vpRef}
      className={`desk ${panning ? "panning" : ""}`}
      onPointerDown={onViewportPointerDown}
      onPointerMove={movePointer}
      onPointerUp={(e) => endPointer(e)}
      onPointerCancel={() => endPointer()}
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
        />
        {objects.map((obj) => {
          const size = nodeSize(obj);
          const isSelected = selectedSet.has(obj.id);
          const showHandles = isSelected || Boolean(connect.current);
          return (
            <div
              key={`${obj.id}-${focusRequest?.id === obj.id ? focusRequest.token : "idle"}`}
              className={`obj obj-${obj.kind} ${focusRequest?.id === obj.id ? "obj-focused" : ""} ${isSelected ? "obj-selected" : ""}`}
              style={{ left: obj.x, top: obj.y, transform: `rotate(${obj.rot}deg)` }}
              onPointerDown={(e) => startNodeDrag(e, obj)}
              onClick={(e) => onObjectClick(e, obj)}
              onDragStart={(e) => e.preventDefault()}
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
      {marqueeStyle && (
        <div className="desk-marquee" style={marqueeStyle} aria-hidden="true" />
      )}
      {toolbarObject && renderNodeToolbar && (
        <div
          className="desk-node-toolbar"
          style={{
            left: view.x + (toolbarObject.x + nodeSize(toolbarObject).w / 2) * view.zoom,
            top: view.y + toolbarObject.y * view.zoom - 14,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {renderNodeToolbar(toolbarObject)}
        </div>
      )}
      <div className="desk-tools">
        <button
          type="button"
          aria-label="放大"
          disabled={view.zoom >= ZOOM_MAX}
          onClick={() => setView((v) => {
            const next = { ...v, zoom: clampZoom(v.zoom + 0.1) };
            reportViewport(next);
            return next;
          })}
        >
          +
        </button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          aria-label="缩小"
          disabled={view.zoom <= ZOOM_MIN}
          onClick={() => setView((v) => {
            const next = { ...v, zoom: clampZoom(v.zoom - 0.1) };
            reportViewport(next);
            return next;
          })}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => {
            const next = { x: 40, y: 20, zoom: 0.62 };
            setView(next);
            reportViewport(next);
          }}
        >
          复位
        </button>
      </div>
      {overlay}
    </div>
  );
}
