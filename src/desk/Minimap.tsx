/**
 * 画布 Minimap：左下角小地图 + 视口框（Figma/Miro 式平移导航）。
 *  - DOM 缩放渲染：物件块用 obj.url 缩略（浏览器缓存与画布节点同源），连线 SVG
 *  - 拖视口框 / 拖地图空白 → panByMapDelta 实时平移；点击空白 → centerOnMapPoint
 *  - 只做平移：不缩放、不做对象交互；空桌不渲染
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { bezierPath, nodeSize, routeAnchors } from "./connection-geometry";
import type { Viewport } from "./geometry";
import {
  centerOnMapPoint,
  minimapTransform,
  panByMapDelta,
  toMap,
  viewportRect,
  worldBounds,
  type Size,
} from "./minimap-geometry";
import type { DeskConnection, DeskObject } from "./types";

const MAP_SIZE: Size = { w: 200, h: 140 };

export function Minimap({
  objects,
  connections = [],
  selectedIds = [],
  view,
  canvasSize,
  onPan,
}: {
  objects: DeskObject[];
  connections?: DeskConnection[];
  selectedIds?: string[];
  view: Viewport;
  canvasSize: Size;
  onPan: (next: Viewport) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startY: number; base: Viewport }>();
  const mapRef = useRef<HTMLDivElement>(null);

  if (objects.length === 0 || canvasSize.w === 0 || canvasSize.h === 0) return null;

  const t = minimapTransform(worldBounds(objects), MAP_SIZE);
  const rect = viewportRect(view, canvasSize, t);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const selectedSet = new Set(selectedIds);

  /** 相对地图容器的指针坐标。 */
  const mapPoint = (e: ReactPointerEvent) => {
    const box = mapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  const startDrag = (e: ReactPointerEvent, base: Viewport) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base };
  };

  /** 视口框：从当前视口起拖。 */
  const onViewportPointerDown = (e: ReactPointerEvent) => startDrag(e, view);

  /** 地图空白：先居中到点击点，再从新视口起拖（Figma 的 jump+scrub）。 */
  const onMapPointerDown = (e: ReactPointerEvent) => {
    const next = centerOnMapPoint(view, mapPoint(e), t, canvasSize);
    onPan(next);
    startDrag(e, next);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    onPan(panByMapDelta(d.base, e.clientX - d.startX, e.clientY - d.startY, t));
  };

  const endDrag = (e: ReactPointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = undefined;
  };

  return (
    <div
      ref={mapRef}
      className="desk-minimap"
      style={{ width: MAP_SIZE.w, height: MAP_SIZE.h }}
      role="navigation"
      aria-label="画布导航"
      onPointerDown={onMapPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg className="desk-minimap-edges" width={MAP_SIZE.w} height={MAP_SIZE.h} aria-hidden="true">
        {/* 世界坐标系内布线：bezierPath 的 50px 最小控制长是世界单位，
            经 scale 微缩后比例正确；直接拿地图坐标算路径会被最小控制长拧成乱线。
            vector-effect 保持线宽不随缩放变细。 */}
        <g transform={`translate(${t.offsetX} ${t.offsetY}) scale(${t.scale})`}>
          {connections.map((c) => {
            const a = byId.get(c.from);
            const b = byId.get(c.to);
            if (!a || !b) return null;
            const { fromSide, toSide, start, end } = routeAnchors(a, b);
            return (
              <path
                key={c.id}
                d={bezierPath(start.x, start.y, end.x, end.y, fromSide, toSide)}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
      </svg>
      {objects.map((o) => {
        const size = nodeSize(o);
        const tl = toMap(t, o.x, o.y);
        const state = o.pending ? "pending" : o.error ? "failed" : o.url ? "ready" : "empty";
        const selected = selectedSet.has(o.id);
        return (
          <div
            key={o.id}
            className={`desk-minimap-obj desk-minimap-obj-${state}${selected ? " desk-minimap-obj-selected" : ""}`}
            style={{ left: tl.x, top: tl.y, width: size.w * t.scale, height: size.h * t.scale }}
          >
            {o.url && <img src={o.url} alt="" draggable={false} />}
          </div>
        );
      })}
      <div
        className="desk-minimap-viewport"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        aria-hidden="true"
        onPointerDown={onViewportPointerDown}
      />
    </div>
  );
}
