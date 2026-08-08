import type { DeskObject } from "./types";

export const NODE_SIZE: Record<DeskObject["kind"], { w: number; h: number }> = {
  canvas_image: { w: 220, h: 160 },
  effect_image: { w: 220, h: 160 },
};

export function nodeSize(obj: DeskObject) {
  return NODE_SIZE[obj.kind];
}

/** CSS rotate 为正角顺时针（Y 向下）；局部点相对中心。 */
function rotateLocal(obj: DeskObject, localX: number, localY: number) {
  const { w, h } = nodeSize(obj);
  const cx = obj.x + w / 2;
  const cy = obj.y + h / 2;
  const rad = (obj.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // CSS matrix: x' = x cos − y sin, y' = x sin + y cos
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  };
}

/** 右缘中点 = source 锚点（含 rot）。 */
export function sourceAnchor(obj: DeskObject) {
  const { w } = nodeSize(obj);
  return rotateLocal(obj, w / 2, 0);
}

/** 左缘中点 = target 锚点（含 rot）。 */
export function targetAnchor(obj: DeskObject) {
  const { w } = nodeSize(obj);
  return rotateLocal(obj, -w / 2, 0);
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

export function bezierPath(sx: number, sy: number, ex: number, ey: number) {
  const curv = Math.max(Math.abs(ex - sx) * 0.5, 50);
  return `M ${sx} ${sy} C ${sx + curv} ${sy}, ${ex - curv} ${ey}, ${ex} ${ey}`;
}
