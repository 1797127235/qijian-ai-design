/**
 * 生图 size 解析：UI/env 可用 "1:1" / "16:9" / "1024x1024" / "auto"。
 * OpenAI 兼容路径只发 size: "WxH"；空或 auto → undefined（不传，与历史行为一致）。
 * 比例 → 像素：固定短边表（避免把 quality 误当上游字段）。
 */

const SIZE_STEP = 16;
const MAX_EDGE = 3840;
const MAX_RATIO = 3;

/** 比例 → 短边像素（1k 档，与当前 grok quality 模型稳妥） */
const RATIO_SHORT_SIDE = 1024;

export type ImageSizePreference = string | undefined | null;

export function resolveRequestSize(size: ImageSizePreference): string | undefined {
  if (size == null) return undefined;
  const value = String(size).trim();
  if (!value || value.toLowerCase() === "auto") return undefined;

  try {
    const dims = parseDimensions(value);
    if (dims) {
      validate(dims.w, dims.h);
      return `${dims.w}x${dims.h}`;
    }

    if (value.includes(":")) {
      const ratio = parseRatio(value);
      if (!ratio) return undefined;
      return sizeFromRatio(ratio.w, ratio.h);
    }
  } catch {
    return undefined;
  }

  // 非法格式：不抛，交给调用方 omit（契约：不因 size 硬失败）
  return undefined;
}

function parseDimensions(value: string): { w: number; h: number } | null {
  const m = value.match(/^(\d+)x(\d+)$/i);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** 非法比例返回 null（不伪装成 1:1）。 */
function parseRatio(value: string): { w: number; h: number } | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

function sizeFromRatio(rw: number, rh: number): string {
  const landscape = rw >= rh;
  const longRatio = landscape ? rw / rh : rh / rw;
  if (longRatio > MAX_RATIO) {
    // 极端比例：clamp 到 3:1 再算
    const clamped = MAX_RATIO;
    const short = RATIO_SHORT_SIDE;
    const long = align(Math.round(short * clamped));
    return landscape ? `${long}x${short}` : `${short}x${long}`;
  }
  const short = RATIO_SHORT_SIDE;
  const long = align(Math.round(short * longRatio));
  const w = landscape ? long : short;
  const h = landscape ? short : long;
  validate(w, h);
  return `${w}x${h}`;
}

function align(n: number) {
  return Math.max(SIZE_STEP, Math.round(n / SIZE_STEP) * SIZE_STEP);
}

function validate(w: number, h: number) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error("invalid size");
  }
  if (w % SIZE_STEP !== 0 || h % SIZE_STEP !== 0) throw new Error("size must be multiple of 16");
  if (Math.max(w, h) > MAX_EDGE) throw new Error("edge too large");
  if (Math.max(w, h) / Math.min(w, h) > MAX_RATIO) throw new Error("ratio too extreme");
}

/** 展示摘要：auto / 1:1 / 16:9 / 1024x1024 */
export function formatSizeLabel(size: ImageSizePreference): string {
  if (size == null || !String(size).trim() || String(size).trim().toLowerCase() === "auto") return "自动";
  return String(size).trim();
}
