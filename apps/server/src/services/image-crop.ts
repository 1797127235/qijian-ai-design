import { createCanvas, Image } from "@napi-rs/canvas";
import { HttpError } from "../lib/errors.js";

/**
 * 局部重绘的图像工具：按归一化 region 裁剪 + 双图左右合成。
 *
 * 为什么在这里做：grok-imagine edit 只收单张参考图，「框选区域」与「用户上传参考图」
 * 必须先合成一张再发（见 docs/canvas-inpainting-design.md）。
 */

/** 归一化选区：相对原图的 0–1 坐标。 */
export interface ImageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 选区任一边小于 2% 视为误触（与路由层 422 口径一致）。 */
export const MIN_REGION_SIDE = 0.02;

const COMPOSE_GAP = 16;
const MAX_SIDE = 4096;

/** 解码图片 bytes 为 napi-rs Image；解码失败抛 HttpError（422，调用方自身数据问题）。 */
async function decode(bytes: Uint8Array): Promise<Image> {
  const img = new Image();
  try {
    img.src = Buffer.from(bytes);
    await img.decode(); // 必须 await：否则 drawImage 画出透明黑（napi-rs 异步解码）
  } catch {
    throw new HttpError(422, "无法解码图片数据");
  }
  if (!img.width || !img.height) throw new HttpError(422, "无法解码图片数据");
  return img;
}

/** 按归一化 region 裁剪，输出 PNG bytes；越界 clamp 到图内。 */
export async function cropImage(bytes: Uint8Array, mediaType: string, region: ImageRegion): Promise<Uint8Array> {
  void mediaType; // 解码靠内容而非声明类型；保留参数与调用方签名一致
  const img = await decode(bytes);
  if (region.w < MIN_REGION_SIDE || region.h < MIN_REGION_SIDE) {
    throw new HttpError(422, "选区过小：请框选至少 2% 的图片区域");
  }
  const sx = Math.max(0, Math.min(img.width - 1, Math.round(region.x * img.width)));
  const sy = Math.max(0, Math.min(img.height - 1, Math.round(region.y * img.height)));
  const sw = Math.max(1, Math.min(img.width - sx, Math.round(region.w * img.width)));
  const sh = Math.max(1, Math.min(img.height - sy, Math.round(region.h * img.height)));
  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** 「左图 | 右图」等高合成（垂直居中、白底间隔），输出 PNG bytes；宽或高超过 MAX_SIDE 则 422。 */
export async function composeSideBySide(
  left: { bytes: Uint8Array; mediaType: string },
  right: { bytes: Uint8Array; mediaType: string },
): Promise<Uint8Array> {
  void left.mediaType;
  void right.mediaType;
  const a = await decode(left.bytes);
  const b = await decode(right.bytes);
  const width = a.width + b.width + COMPOSE_GAP;
  const height = Math.max(a.height, b.height);
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new HttpError(422, "参考图尺寸过大，无法合成");
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(a, 0, Math.round((height - a.height) / 2));
  ctx.drawImage(b, a.width + COMPOSE_GAP, Math.round((height - b.height) / 2));
  return new Uint8Array(canvas.toBuffer("image/png"));
}
