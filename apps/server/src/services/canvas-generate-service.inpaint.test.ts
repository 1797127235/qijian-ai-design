import { describe, expect, it } from "vitest";
import { createCanvas, Image } from "@napi-rs/canvas";
import {
  buildInpaintReferences,
  composeCanvasPrompt,
  stripInpaintPrefix,
} from "./canvas-generate-service.js";

function makePng(width: number, height: number, color: string) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

async function dims(bytes: Uint8Array) {
  const img = new Image();
  img.src = Buffer.from(bytes);
  await img.decode();
  return { width: img.width, height: img.height };
}

describe("buildInpaintReferences", () => {
  it("无 region 且无参考图：原样返回（回归）", async () => {
    const source = { bytes: makePng(400, 300, "#ff0000"), mediaType: "image/png" };
    const out = await buildInpaintReferences({ referenceFiles: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toBe(source.bytes);
  });

  it("有 region：裁剪源图替换整图参考", async () => {
    const source = { bytes: makePng(400, 300, "#ff0000"), mediaType: "image/png" };
    const out = await buildInpaintReferences({
      referenceFiles: [source],
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].bytes).not.toBe(source.bytes);
    expect(await dims(out[0].bytes)).toEqual({ width: 200, height: 150 });
  });

  it("region + 上传参考图：合成为单张 ref", async () => {
    const source = { bytes: makePng(400, 300, "#ff0000"), mediaType: "image/png" };
    const ref = { bytes: makePng(100, 150, "#00ff00"), mediaType: "image/png" };
    const out = await buildInpaintReferences({
      referenceFiles: [source],
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
      referenceFile: ref,
    });
    expect(out).toHaveLength(1);
    // 裁剪 200×150 + 参考 100×150 + 16 间隔
    expect(await dims(out[0].bytes)).toEqual({ width: 200 + 100 + 16, height: 150 });
  });

  it("只有上传参考图（无 region）：参考图作为唯一 ref", async () => {
    const source = { bytes: makePng(400, 300, "#ff0000"), mediaType: "image/png" };
    const ref = { bytes: makePng(100, 150, "#00ff00"), mediaType: "image/png" };
    const out = await buildInpaintReferences({
      referenceFiles: [source],
      referenceFile: ref,
    });
    expect(out).toHaveLength(1);
    expect(await dims(out[0].bytes)).toEqual({ width: 100, height: 150 });
  });

  it("有 region 但源图缺失：退化为原参考列表", async () => {
    const out = await buildInpaintReferences({
      referenceFiles: [],
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
    expect(out).toHaveLength(0);
  });
});

describe("composeCanvasPrompt / stripInpaintPrefix", () => {
  it("无 region：原样拼便签，不加重绘前缀", () => {
    expect(composeCanvasPrompt({
      userPrompt: "暖色调",
      noteTexts: ["木地板"],
      missingRef: false,
    })).toBe("暖色调\n参考要求：木地板");
  });

  it("有 region：只加一次局部重绘前缀", () => {
    const once = composeCanvasPrompt({
      userPrompt: "换成绿沙发",
      noteTexts: [],
      missingRef: false,
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
    expect(once.startsWith("局部重绘：")).toBe(true);
    expect(once.endsWith("换成绿沙发")).toBe(true);
    expect(once.match(/局部重绘：/g)).toHaveLength(1);
  });

  it("重试带回已 composed prompt：strip 后仍只加一次前缀", () => {
    const leaked = composeCanvasPrompt({
      userPrompt: "换成绿沙发",
      noteTexts: [],
      missingRef: false,
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
      hasReferenceFile: true,
    });
    const again = composeCanvasPrompt({
      userPrompt: leaked,
      noteTexts: [],
      missingRef: false,
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
      hasReferenceFile: true,
    });
    expect(again.match(/局部重绘：/g)).toHaveLength(1);
    expect(stripInpaintPrefix(leaked)).toBe("换成绿沙发");
    expect(again).toContain("左图为待修改区域");
  });

  it("空 prompt 兜底为「生成效果图」", () => {
    expect(composeCanvasPrompt({
      userPrompt: "  ",
      noteTexts: [],
      missingRef: false,
    })).toBe("生成效果图");
  });
});
