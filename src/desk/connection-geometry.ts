import type { DeskObject } from "./types";

export const NODE_SIZE: Record<DeskObject["kind"], { w: number; h: number }> = {
  canvas_image: { w: 220, h: 160 },
  effect_image: { w: 220, h: 160 },
};

export const NODE_W_MIN = 80;
export const NODE_W_MAX = 960;

export type ConnSide = "left" | "right" | "top" | "bottom";

export function defaultAspect(kind: DeskObject["kind"]) {
  const base = NODE_SIZE[kind];
  return base.h / base.w;
}

export function clampNodeWidth(w: number) {
  if (!Number.isFinite(w)) return NODE_SIZE.canvas_image.w;
  return Math.min(NODE_W_MAX, Math.max(NODE_W_MIN, Math.round(w)));
}

/** 有 layout.w 时按默认比例推 h，保证连线/框选/选框一致。 */
export function nodeSize(obj: DeskObject) {
  const base = NODE_SIZE[obj.kind];
  const w = obj.w && obj.w > 0 ? clampNodeWidth(obj.w) : base.w;
  const h = Math.round(base.h * (w / base.w));
  return { w, h };
}

/** CSS rotate 为正角顺时针（Y 向下）；局部点相对中心。 */
function rotateLocal(obj: DeskObject, localX: number, localY: number) {
  const { w, h } = nodeSize(obj);
  const cx = obj.x + w / 2;
  const cy = obj.y + h / 2;
  const rad = (obj.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  };
}

export function nodeCenter(obj: DeskObject) {
  const { w, h } = nodeSize(obj);
  return { x: obj.x + w / 2, y: obj.y + h / 2 };
}

/** 四缘中点锚点（含 rot）。 */
export function edgeAnchor(obj: DeskObject, side: ConnSide) {
  const { w, h } = nodeSize(obj);
  switch (side) {
    case "right":
      return rotateLocal(obj, w / 2, 0);
    case "left":
      return rotateLocal(obj, -w / 2, 0);
    case "top":
      return rotateLocal(obj, 0, -h / 2);
    case "bottom":
      return rotateLocal(obj, 0, h / 2);
  }
}

/** 右缘中点 = 默认 source（兼容旧调用）。 */
export function sourceAnchor(obj: DeskObject) {
  return edgeAnchor(obj, "right");
}

/** 左缘中点 = 默认 target（兼容旧调用）。 */
export function targetAnchor(obj: DeskObject) {
  return edgeAnchor(obj, "left");
}

/** 边的外法向（世界轴对齐；rot 节点仍用局部边，控制点沿该边外向）。 */
export function sideOutward(side: ConnSide): { x: number; y: number } {
  switch (side) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
  }
}

/**
 * 按两节点中心相对位置选进出边：主轴占优。
 * 下置目标 → from=bottom / to=top（截图形态）。
 */
export function pickRoute(from: DeskObject, to: DeskObject): { fromSide: ConnSide; toSide: ConnSide } {
  const a = nodeCenter(from);
  const b = nodeCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0
    ? { fromSide: "bottom", toSide: "top" }
    : { fromSide: "top", toSide: "bottom" };
}

export function routeAnchors(from: DeskObject, to: DeskObject) {
  const { fromSide, toSide } = pickRoute(from, to);
  return {
    fromSide,
    toSide,
    start: edgeAnchor(from, fromSide),
    end: edgeAnchor(to, toSide),
  };
}

function controlLength(sx: number, sy: number, ex: number, ey: number) {
  const dist = Math.hypot(ex - sx, ey - sy);
  return Math.max(dist * 0.4, 50);
}

/** 方向感知三次贝塞尔：控制点沿出/入边外法向。 */
export function bezierPath(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  fromSide: ConnSide = "right",
  toSide: ConnSide = "left",
) {
  const curv = controlLength(sx, sy, ex, ey);
  const o1 = sideOutward(fromSide);
  const o2 = sideOutward(toSide);
  const c1x = sx + o1.x * curv;
  const c1y = sy + o1.y * curv;
  const c2x = ex + o2.x * curv;
  const c2y = ey + o2.y * curv;
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`;
}

export function bezierMid(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  fromSide: ConnSide = "right",
  toSide: ConnSide = "left",
) {
  const curv = controlLength(sx, sy, ex, ey);
  const o1 = sideOutward(fromSide);
  const o2 = sideOutward(toSide);
  const c1x = sx + o1.x * curv;
  const c1y = sy + o1.y * curv;
  const c2x = ex + o2.x * curv;
  const c2y = ey + o2.y * curv;
  const t = 0.5;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
    y: mt * mt * mt * sy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey,
  };
}

/** 旋转后的轴对齐包围盒（框选/命中用）。 */
export function nodeAabb(obj: DeskObject) {
  const { w, h } = nodeSize(obj);
  if (!obj.rot) return { x: obj.x, y: obj.y, w, h };
  const corners = [
    rotateLocal(obj, -w / 2, -h / 2),
    rotateLocal(obj, w / 2, -h / 2),
    rotateLocal(obj, w / 2, h / 2),
    rotateLocal(obj, -w / 2, h / 2),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
}

/** 把手在节点本地 CSS 定位（未旋转容器内）。 */
export function handleStyle(side: ConnSide, size: { w: number; h: number }): { left: number; top: number } {
  switch (side) {
    case "left":
      return { left: -5, top: size.h / 2 - 5 };
    case "right":
      return { left: size.w - 5, top: size.h / 2 - 5 };
    case "top":
      return { left: size.w / 2 - 5, top: -5 };
    case "bottom":
      return { left: size.w / 2 - 5, top: size.h - 5 };
  }
}
