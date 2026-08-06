import type { DeskObject } from "./types";

export const NODE_SIZE: Record<DeskObject["kind"], { w: number; h: number }> = {
  sticky_note: { w: 210, h: 140 },
  canvas_image: { w: 220, h: 160 },
  effect_image: { w: 220, h: 160 },
};

export function nodeSize(obj: DeskObject) {
  return NODE_SIZE[obj.kind];
}

/** 右缘中点 = source 锚点；左缘中点 = target 锚点（世界坐标）。 */
export function sourceAnchor(obj: DeskObject) {
  const { w, h } = nodeSize(obj);
  return { x: obj.x + w, y: obj.y + h / 2 };
}

export function targetAnchor(obj: DeskObject) {
  const { h } = nodeSize(obj);
  return { x: obj.x, y: obj.y + h / 2 };
}

export function bezierPath(sx: number, sy: number, ex: number, ey: number) {
  const curv = Math.max(Math.abs(ex - sx) * 0.5, 50);
  return `M ${sx} ${sy} C ${sx + curv} ${sy}, ${ex - curv} ${ey}, ${ex} ${ey}`;
}
