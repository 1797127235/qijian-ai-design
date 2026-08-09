import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionsLayer } from "./Connections";
import { Minimap } from "./Minimap";
import {
  edgeAnchor,
  handleStyle,
  nodeAabb,
  nodeSize,
  pickRoute,
  type ConnSide,
} from "./connection-geometry";
import { positionFromPointer, screenToWorld, zoomAtPoint, type Viewport } from "./geometry";
import {
  objectAspect,
  RESIZE_HANDLES,
  resizeFromHandle,
  resizeHandleCursor,
  resizeHandleStyle,
  startSizeOf,
  type ResizeHandle,
} from "./resize-geometry";
import type { DeskConnection, DeskObject } from "./types";
import { useExitTransition } from "./useExitTransition";

/** 与服务端 PATCH /desk viewport.zoom 一致（apps/server desk 路由 z.number().min(0.1).max(4)） */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;

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
  onResize,
  onResizeEnd,
  initialViewport,
  onViewportChange,
  focusRequest,
  selectedIds = [],
  selectedConnectionId,
  onSelect,
  onMarqueeSelect,
  onSelectConnection,
  onDeleteConnection,
  onDropFiles,
  onCreateConnection,
  onConnectStart,
  onObjectDoubleClick,
  renderObject,
  renderNodeToolbar,
  overlay,
  children,
}: {
  objects: DeskObject[];
  connections?: DeskConnection[];
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd?: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => void;
  /** 选中框边/角拖动：等比改 w，并可能平移 x/y 固定对边 */
  onResize?: (id: string, next: { x: number; y: number; w: number }) => void;
  onResizeEnd?: (
    id: string,
    from: { x: number; y: number; w: number },
    to: { x: number; y: number; w: number },
  ) => void;
  initialViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  focusRequest?: { id: string; token: number };
  selectedIds?: string[];
  selectedConnectionId?: string;
  onSelect?: (id?: string, opts?: SelectOpts) => void;
  onMarqueeSelect?: (ids: string[]) => void;
  onSelectConnection?: (id?: string) => void;
  onDeleteConnection?: (id: string) => void;
  onDropFiles?: (files: File[]) => void;
  onCreateConnection?: (from: string, to: string) => void;
  /** 开始从把手拖连线（用于收起生图面板等） */
  onConnectStart?: () => void;
  /** 物件双击（画布拖拽会吞原生 dblclick，这里用点击间隔识别） */
  onObjectDoubleClick?: (obj: DeskObject) => void;
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
  const resize = useRef<{
    id: string;
    handle: ResizeHandle;
    start: { x: number; y: number; w: number; h: number };
    aspect: number;
  }>();
  const lastResize = useRef<{ id: string; x: number; y: number; w: number }>();
  const connect = useRef<{ fromId: string; side: ConnSide; x: number; y: number }>();
  const pendingClick = useRef<{ id: string; x: number; y: number; shift: boolean }>();
  const lastTap = useRef<{ id: string; at: number }>();
  const [preview, setPreview] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    fromSide?: ConnSide;
    toSide?: ConnSide;
  }>();
  const vpRef = useRef<HTMLDivElement>(null);
  const handledFocusToken = useRef<number>();
  const spaceHeld = useRef(false);
  /** 画布可视区尺寸（Minimap 视口框换算用），ResizeObserver 跟随窗口变化 */
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const measure = () => setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 仅应用服务端/父级视口到本地 view；禁止 onViewportChange，避免 bootstrap 或远端内容刷新触发视口回写。
  useEffect(() => {
    if (initialViewport) {
      setView({ ...initialViewport, zoom: clampZoom(initialViewport.zoom) });
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
    if ((e.target as HTMLElement).closest(".obj, button, input, textarea, select, a, .conn-handle, .resize-handle, .conn-hit, .desk-prompt-panel")) return;

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
    if (resize.current && onResize) {
      const r = resize.current;
      const next = resizeFromHandle(r.start, r.handle, worldFromEvent(e), r.aspect);
      lastResize.current = { id: r.id, ...next };
      onResize(r.id, next);
      return;
    }

    if (connect.current) {
      const p = worldFromEvent(e);
      const fromObj = objects.find((o) => o.id === connect.current!.fromId);
      let fromSide = connect.current.side;
      let start = { x: connect.current.x, y: connect.current.y };
      let toSide: ConnSide = "left";
      let end = p;
      if (fromObj) {
        const hover = objects.find((obj) => {
          if (obj.id === connect.current!.fromId) return false;
          const box = nodeAabb(obj);
          return p.x >= box.x - 12 && p.x <= box.x + box.w + 12 && p.y >= box.y - 12 && p.y <= box.y + box.h + 12;
        });
        if (hover) {
          // 悬停目标时预览与落线一致：按相对位置自动选边
          const route = pickRoute(fromObj, hover);
          fromSide = route.fromSide;
          toSide = route.toSide;
          start = edgeAnchor(fromObj, fromSide);
          end = edgeAnchor(hover, toSide);
        }
      }
      setPreview({
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        fromSide,
        toSide,
      });
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
    if (resize.current && lastResize.current) {
      const start = resize.current.start;
      const to = lastResize.current;
      const changed =
        Math.round(start.x) !== Math.round(to.x)
        || Math.round(start.y) !== Math.round(to.y)
        || Math.round(start.w) !== Math.round(to.w);
      if (changed) {
        onResizeEnd?.(to.id, { x: start.x, y: start.y, w: start.w }, { x: to.x, y: to.y, w: to.w });
      }
    }
    resize.current = undefined;
    lastResize.current = undefined;
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

  const startResize = (e: React.PointerEvent, obj: DeskObject, handle: ResizeHandle) => {
    if (e.button !== 0 || !onResize) return;
    e.stopPropagation();
    e.preventDefault();
    pendingClick.current = undefined;
    lastTap.current = undefined;
    drag.current = undefined;
    dragStart.current = undefined;
    onSelect?.(obj.id, { panel: false });
    onSelectConnection?.(undefined);
    const start = startSizeOf(obj);
    resize.current = { id: obj.id, handle, start, aspect: objectAspect(obj) };
    lastResize.current = { id: obj.id, x: start.x, y: start.y, w: start.w };
    try {
      vpRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
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
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .conn-handle, .resize-handle")) return;
    e.stopPropagation();
    const toggle = e.shiftKey;
    const now = performance.now();
    const prev = lastTap.current;
    // 原生 dblclick 会被拖拽/选中链路吞掉；用 pointerdown 间隔识别双击
    if (!toggle && prev && prev.id === obj.id && now - prev.at < 350) {
      lastTap.current = undefined;
      selectObject(obj, { panel: false });
      onObjectDoubleClick?.(obj);
      return;
    }
    lastTap.current = { id: obj.id, at: now };
    selectObject(obj, { panel: !toggle, toggle });
    pendingClick.current = { id: obj.id, x: e.clientX, y: e.clientY, shift: toggle };
  };

  const onObjectClick = (e: React.MouseEvent, obj: DeskObject) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .conn-handle, .resize-handle")) return;
    e.stopPropagation();
    // 选中已在 pointerdown 完成；此处仅兜底（如无 pointer 路径）
    if (!lastTap.current || lastTap.current.id !== obj.id) {
      const toggle = e.shiftKey;
      selectObject(obj, { panel: !toggle, toggle });
    }
  };

  const startConnect = (e: React.PointerEvent, obj: DeskObject, side: ConnSide) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onConnectStart?.();
    const a = edgeAnchor(obj, side);
    connect.current = { fromId: obj.id, side, x: a.x, y: a.y };
    setPreview({ x1: a.x, y1: a.y, x2: a.x, y2: a.y, fromSide: side, toSide: "left" });
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
  const toolbar = useExitTransition(toolbarObject, 120);
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
            // 勿再调 onSelect(undefined)：Workbench 的 onSelect 会清掉 selectedConnectionId
            onSelectConnection?.(id);
          }}
          onDelete={onDeleteConnection}
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
              {obj.alias && (
                <span className="desk-alias-badge" title={`对话编号 ${obj.alias}`}>{obj.alias}</span>
              )}
              {renderObject(obj)}
              {showHandles && onCreateConnection && (
                <>
                  {(["left", "right", "top", "bottom"] as const).map((side) => {
                    const pos = handleStyle(side, size);
                    return (
                      <span
                        key={side}
                        className="conn-handle conn-handle-source"
                        style={{ left: pos.left, top: pos.top }}
                        title={`从${side === "left" ? "左" : side === "right" ? "右" : side === "top" ? "上" : "下"}拖出连线`}
                        onPointerDown={(e) => startConnect(e, obj, side)}
                      />
                    );
                  })}
                </>
              )}
              {isSelected && selectedIds.length === 1 && onResize && (
                <>
                  {RESIZE_HANDLES.map((handle) => {
                    const pos = resizeHandleStyle(handle, size);
                    const isEdge = handle === "n" || handle === "s" || handle === "e" || handle === "w";
                    return (
                      <span
                        key={handle}
                        className={`resize-handle resize-handle-${handle}${isEdge ? " resize-handle-edge" : " resize-handle-corner"}`}
                        style={{
                          left: pos.left,
                          top: pos.top,
                          width: pos.width,
                          height: pos.height,
                          cursor: resizeHandleCursor(handle),
                        }}
                        title="拖动缩放"
                        onPointerDown={(e) => startResize(e, obj, handle)}
                      />
                    );
                  })}
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
      {toolbar.rendered && renderNodeToolbar && (
        <div
          className={`desk-node-toolbar${toolbar.closing ? " closing" : ""}`}
          style={{
            left: view.x + (toolbar.rendered.x + nodeSize(toolbar.rendered).w / 2) * view.zoom,
            top: view.y + toolbar.rendered.y * view.zoom - 14,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {renderNodeToolbar(toolbar.rendered)}
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
      <Minimap
        objects={objects}
        connections={connections}
        selectedIds={selectedIds}
        view={view}
        canvasSize={canvasSize}
        onPan={(next) => {
          setView(next);
          reportViewport(next);
        }}
      />
      {overlay}
    </div>
  );
}
