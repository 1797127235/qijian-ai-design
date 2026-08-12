/** 归一化选区（0–1，源图本地坐标）。 */
export interface InpaintRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 选区任一边占比小于 2% 视为误触（与服务端 MIN_REGION_SIDE 对齐）。 */
export const MIN_REGION_RATIO = 0.02;

/**
 * 两个本地坐标点 → 归一化 rect（clamp 到图内，与拖拽方向无关）。
 * 任一边占比 < 2% 返回 undefined（误触）。
 */
export function normalizeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: { w: number; h: number },
): InpaintRegion | undefined {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const x1 = clamp(Math.min(a.x, b.x), size.w);
  const y1 = clamp(Math.min(a.y, b.y), size.h);
  const x2 = clamp(Math.max(a.x, b.x), size.w);
  const y2 = clamp(Math.max(a.y, b.y), size.h);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w / size.w < MIN_REGION_RATIO || h / size.h < MIN_REGION_RATIO) return undefined;
  return { x: x1 / size.w, y: y1 / size.h, w: w / size.w, h: h / size.h };
}
