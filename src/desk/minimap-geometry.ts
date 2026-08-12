/**
 * Minimap 几何：世界坐标 ↔ 小地图像素 ↔ 视口偏移的纯函数换算。
 * 单一事实源：节点尺寸用 nodeSize（与画布一致），视口反投影用 screenToWorld。
 */
import { nodeSize } from "./connection-geometry";
import { screenToWorld, type Viewport } from "./geometry";
import type { DeskObject } from "./types";

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type MapTransform = { scale: number; offsetX: number; offsetY: number };
export type MapRect = { x: number; y: number; w: number; h: number };

/** 世界包围盒外扩的默认边距（世界坐标像素）。 */
export const WORLD_PAD = 120;

/** 全桌包围盒 + padding；空桌给一个以原点为中心的有限默认盒（避免 NaN/除零）。 */
export function worldBounds(objects: DeskObject[], pad = WORLD_PAD): Bounds {
  if (objects.length === 0) {
    return { minX: -pad, minY: -pad, maxX: pad, maxY: pad };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const obj of objects) {
    const { w, h } = nodeSize(obj);
    minX = Math.min(minX, obj.x);
    minY = Math.min(minY, obj.y);
    maxX = Math.max(maxX, obj.x + w);
    maxY = Math.max(maxY, obj.y + h);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** 世界 → 地图像素：等比缩放 + 居中（contain 语义）。 */
export function minimapTransform(bounds: Bounds, map: Size): MapTransform {
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(map.w / worldW, map.h / worldH);
  return {
    scale,
    offsetX: (map.w - worldW * scale) / 2 - bounds.minX * scale,
    offsetY: (map.h - worldH * scale) / 2 - bounds.minY * scale,
  };
}

export function toMap(t: MapTransform, x: number, y: number): Point {
  return { x: t.offsetX + x * t.scale, y: t.offsetY + y * t.scale };
}

/** 当前视口的可见世界区在地图上的矩形。 */
export function viewportRect(view: Viewport, canvas: Size, t: MapTransform): MapRect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, { x: 0, y: 0 }, view);
  const bottomRight = screenToWorld({ x: canvas.w, y: canvas.h }, { x: 0, y: 0 }, view);
  const a = toMap(t, topLeft.x, topLeft.y);
  const b = toMap(t, bottomRight.x, bottomRight.y);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/** 拖动视口框：地图位移 ÷ scale = 世界位移；视口反向移动（zoom 不变）。 */
export function panByMapDelta(view: Viewport, dxMap: number, dyMap: number, t: MapTransform): Viewport {
  return {
    ...view,
    x: view.x - (dxMap / t.scale) * view.zoom,
    y: view.y - (dyMap / t.scale) * view.zoom,
  };
}

/** 点击地图：让对应世界点居中于画布（zoom 不变）。 */
export function centerOnMapPoint(view: Viewport, mapPt: Point, t: MapTransform, canvas: Size): Viewport {
  const worldX = (mapPt.x - t.offsetX) / t.scale;
  const worldY = (mapPt.y - t.offsetY) / t.scale;
  return {
    ...view,
    x: canvas.w / 2 - worldX * view.zoom,
    y: canvas.h / 2 - worldY * view.zoom,
  };
}
