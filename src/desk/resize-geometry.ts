import { clampNodeWidth, defaultAspect, nodeSize } from "./connection-geometry";
import type { DeskObject } from "./types";

/** 四角 + 四边中点 */
export type ResizeHandle =
  | "nw" | "n" | "ne"
  | "w" | "e"
  | "sw" | "s" | "se";

export type ResizeResult = { x: number; y: number; w: number };

/**
 * 等比缩放：固定 aspect = 默认卡比例。
 * 角：对锚点固定；边：沿该边外向改尺寸，对边中点固定。
 */
export function resizeFromHandle(
  start: { x: number; y: number; w: number; h: number },
  handle: ResizeHandle,
  pointer: { x: number; y: number },
  aspect: number,
): ResizeResult {
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;

  let anchorX: number;
  let anchorY: number;
  let rawW: number;
  let rawH: number;

  switch (handle) {
    case "se":
      anchorX = start.x;
      anchorY = start.y;
      rawW = pointer.x - anchorX;
      rawH = pointer.y - anchorY;
      break;
    case "sw":
      anchorX = right;
      anchorY = start.y;
      rawW = anchorX - pointer.x;
      rawH = pointer.y - anchorY;
      break;
    case "ne":
      anchorX = start.x;
      anchorY = bottom;
      rawW = pointer.x - anchorX;
      rawH = anchorY - pointer.y;
      break;
    case "nw":
      anchorX = right;
      anchorY = bottom;
      rawW = anchorX - pointer.x;
      rawH = anchorY - pointer.y;
      break;
    case "e":
      anchorX = start.x;
      anchorY = cy;
      rawW = pointer.x - anchorX;
      rawH = rawW * aspect;
      break;
    case "w":
      anchorX = right;
      anchorY = cy;
      rawW = anchorX - pointer.x;
      rawH = rawW * aspect;
      break;
    case "s":
      anchorX = cx;
      anchorY = start.y;
      rawH = pointer.y - anchorY;
      rawW = rawH / aspect;
      break;
    case "n":
      anchorX = cx;
      anchorY = bottom;
      rawH = anchorY - pointer.y;
      rawW = rawH / aspect;
      break;
  }

  const w = clampNodeWidth(
    handle === "n" || handle === "s" || handle === "e" || handle === "w"
      ? rawW
      : Math.max(rawW, rawH / aspect),
  );
  const h = Math.round(w * aspect);

  switch (handle) {
    case "se":
      return { x: start.x, y: start.y, w };
    case "sw":
      return { x: right - w, y: start.y, w };
    case "ne":
      return { x: start.x, y: bottom - h, w };
    case "nw":
      return { x: right - w, y: bottom - h, w };
    case "e":
      return { x: start.x, y: cy - h / 2, w };
    case "w":
      return { x: right - w, y: cy - h / 2, w };
    case "s":
      return { x: cx - w / 2, y: start.y, w };
    case "n":
      return { x: cx - w / 2, y: bottom - h, w };
  }
}

export function resizeHandleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}

/** 命中区：角方块；边为整条框线（避开四角给角把手）。 */
const CORNER = 14;
const EDGE_T = 14; // 边带厚度（含框线两侧）
const CORNER_GAP = CORNER; // 边条两端让给角

export function resizeHandleStyle(
  handle: ResizeHandle,
  size: { w: number; h: number },
): { left: number; top: number; width: number; height: number } {
  const edgeW = Math.max(8, size.w - CORNER_GAP * 2);
  const edgeH = Math.max(8, size.h - CORNER_GAP * 2);
  switch (handle) {
    case "nw":
      return { left: -CORNER / 2, top: -CORNER / 2, width: CORNER, height: CORNER };
    case "ne":
      return { left: size.w - CORNER / 2, top: -CORNER / 2, width: CORNER, height: CORNER };
    case "sw":
      return { left: -CORNER / 2, top: size.h - CORNER / 2, width: CORNER, height: CORNER };
    case "se":
      return { left: size.w - CORNER / 2, top: size.h - CORNER / 2, width: CORNER, height: CORNER };
    case "n":
      return { left: CORNER_GAP, top: -EDGE_T / 2, width: edgeW, height: EDGE_T };
    case "s":
      return { left: CORNER_GAP, top: size.h - EDGE_T / 2, width: edgeW, height: EDGE_T };
    case "w":
      return { left: -EDGE_T / 2, top: CORNER_GAP, width: EDGE_T, height: edgeH };
    case "e":
      return { left: size.w - EDGE_T / 2, top: CORNER_GAP, width: EDGE_T, height: edgeH };
  }
}

export const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function objectAspect(obj: DeskObject) {
  return defaultAspect(obj.kind);
}

export function startSizeOf(obj: DeskObject) {
  const size = nodeSize(obj);
  return { x: obj.x, y: obj.y, w: size.w, h: size.h };
}
