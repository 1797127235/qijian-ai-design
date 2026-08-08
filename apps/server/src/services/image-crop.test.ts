import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { composeSideBySide, cropImage, type ImageRegion } from "./image-crop.js";

/** 造一张 w×h 纯色 PNG：左上 1/4 红色、其余蓝色，便于断言裁剪区域来源。 */
function makeTestPng(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, width / 2, height / 2);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** 读 PNG 像素 (x,y) 的 RGB（napi-rs 解码后逐像素断言）。 */
async function pixelAt(bytes: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const { Image } = await import("@napi-rs/canvas");
  const img = new Image();
  img.src = Buffer.from(bytes);
  await img.decode();
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(x, y, 1, 1);
  return [data[0], data[1], data[2]];
}

async function pngDims(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const { Image } = await import("@napi-rs/canvas");
  const img = new Image();
  img.src = Buffer.from(bytes);
  await img.decode();
  return { width: img.width, height: img.height };
}

describe("cropImage", () => {
  it("按归一化 region 裁剪出对应尺寸", async () => {
    const src = makeTestPng(400, 300);
    const out = await cropImage(src, "image/png", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(await pngDims(out)).toEqual({ width: 200, height: 150 });
  });

  it("裁剪内容来自原图对应区域", async () => {
    const src = makeTestPng(400, 300);
    // 裁左上 1/4：应全红
    const red = await cropImage(src, "image/png", { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(await pixelAt(red, 10, 10)).toEqual([255, 0, 0]);
    // 裁右下 1/4：应全蓝
    const blue = await cropImage(src, "image/png", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(await pixelAt(blue, 10, 10)).toEqual([0, 0, 255]);
  });

  it("region 越界时 clamp 到图内", async () => {
    const src = makeTestPng(400, 300);
    const out = await cropImage(src, "image/png", { x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
    const dims = await pngDims(out);
    expect(dims.width).toBe(40);
    expect(dims.height).toBe(30);
  });

  it("region 小于 2% 视为误触，抛 422", async () => {
    const src = makeTestPng(400, 300);
    await expect(cropImage(src, "image/png", { x: 0, y: 0, w: 0.01, h: 0.5 })).rejects.toThrow(/选区过小/);
  });

  it("非图片输入报错", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(cropImage(junk, "image/png", { x: 0, y: 0, w: 0.5, h: 0.5 })).rejects.toThrow();
  });

  it("支持 jpeg 输入", async () => {
    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 200, 100);
    const jpeg = new Uint8Array(canvas.toBuffer("image/jpeg"));
    const out = await cropImage(jpeg, "image/jpeg", { x: 0, y: 0, w: 0.5, h: 1 });
    expect(await pngDims(out)).toEqual({ width: 100, height: 100 });
  });
});

describe("composeSideBySide", () => {
  it("输出宽度 = 两图宽 + 间隔，高度取较大者", async () => {
    const a = makeTestPng(200, 100);
    const b = makeTestPng(150, 300);
    const out = await composeSideBySide(
      { bytes: a, mediaType: "image/png" },
      { bytes: b, mediaType: "image/png" },
    );
    const dims = await pngDims(out);
    expect(dims.width).toBe(200 + 150 + 16);
    expect(dims.height).toBe(300);
  });

  it("左图在左、右图在右、间隔为白底", async () => {
    const a = makeTestPng(100, 100);
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 100, 100);
    const b = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await composeSideBySide(
      { bytes: a, mediaType: "image/png" },
      { bytes: b, mediaType: "image/png" },
    );
    expect(await pixelAt(out, 103, 50)).toEqual([255, 255, 255]); // 间隔中点
    expect(await pixelAt(out, 150, 50)).toEqual([0, 255, 0]); // 右图区域
  });

  it("不等高时右图垂直居中", async () => {
    const a = makeTestPng(100, 100);
    const canvas = createCanvas(100, 300);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 100, 300);
    const b = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await composeSideBySide(
      { bytes: a, mediaType: "image/png" },
      { bytes: b, mediaType: "image/png" },
    );
    // 左图（高 100）在总高 300 的画布上居中：左上角应是白底
    expect(await pixelAt(out, 50, 10)).toEqual([255, 255, 255]);
  });
});

describe("ImageRegion 类型", () => {
  it("负坐标 clamp 到图内（值域 422 由路由层把关，工具层防御性 clamp）", async () => {
    const src = makeTestPng(100, 100);
    const out = await cropImage(src, "image/png", { x: -0.5, y: 0, w: 0.5, h: 0.5 });
    expect(await pngDims(out)).toEqual({ width: 50, height: 50 });
  });
});
