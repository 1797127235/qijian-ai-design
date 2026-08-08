import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderDeskOverview } from "./desk-overview-renderer.js";

function solidPng(color: string, w = 40, h = 40): Buffer {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
}

/** 解码 PNG 取某像素 RGB（断言渲染装饰用）。 */
async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2]];
}

// 单 tile(220×160 @ 0,0）时：scale≈4.218，卡片左上 ≈ (48, 174.6)
const CARD_LEFT = 48;
const CARD_TOP = 174.6;

describe("renderDeskOverview", () => {
  it("renders png with aliases and respects maxTiles", async () => {
    const result = await renderDeskOverview({
      maxTiles: 2,
      tiles: [
        { id: "a", alias: "A01", label: "左", lifecycle: "ready", x: 0, y: 0, imageBytes: solidPng("#f00"), highlighted: true },
        { id: "b", alias: "A02", label: "右", lifecycle: "ready", x: 400, y: 0, imageBytes: solidPng("#0f0") },
        { id: "c", alias: "A03", label: "远", lifecycle: "ready", x: 800, y: 0, imageBytes: solidPng("#00f") },
      ],
      edges: [{ fromId: "a", toId: "b" }],
    });
    expect(result.tileCount).toBe(2);
    expect(result.includedIds).toEqual(["a", "b"]);
    expect(result.omittedIds).toEqual(["c"]);
    expect(result.png.length).toBeGreaterThan(100);
    expect(result.mimeType).toBe("image/png");
  });

  it("renders gray tiles when image missing", async () => {
    const result = await renderDeskOverview({
      tiles: [
        { id: "p", alias: "A01", label: "待", lifecycle: "pending", x: 0, y: 0 },
        { id: "r", alias: "A02", label: "好", lifecycle: "ready", x: 300, y: 0, imageBytes: solidPng("#123456") },
      ],
    });
    expect(result.tileCount).toBe(2);
    expect(result.png[0]).toBe(0x89); // PNG magic
  });

  it("human style drops alias badge and highlight stroke", async () => {
    const tiles = [
      { id: "a", alias: "A01", label: "图", lifecycle: "ready" as const, x: 0, y: 0, imageBytes: solidPng("#c8b08a"), highlighted: true },
    ];
    const agent = await renderDeskOverview({ tiles, style: "agent" });
    const human = await renderDeskOverview({ tiles, style: "human" });

    // 角标区（卡片内左上，圆角半径外）：agent 是深色/蓝色 badge，human 不应有深色块
    const agentBadge = await pixelAt(agent.png, CARD_LEFT + 14, CARD_TOP + 17);
    const humanBadge = await pixelAt(human.png, CARD_LEFT + 14, CARD_TOP + 17);
    expect(agentBadge[2]).toBeGreaterThan(150); // highlighted → #2563eb 蓝 badge
    expect(agentBadge[2] - agentBadge[0]).toBeGreaterThan(50);
    expect(humanBadge[0]).toBeGreaterThan(150);

    // 高亮描边（卡片顶边中点）：agent 是 #2563eb 蓝，human 无蓝描边
    const agentEdge = await pixelAt(agent.png, CARD_LEFT + 200, CARD_TOP);
    const humanEdge = await pixelAt(human.png, CARD_LEFT + 200, CARD_TOP);
    expect(agentEdge[2]).toBeGreaterThan(150); // 蓝通道高
    expect(agentEdge[2] - agentEdge[0]).toBeGreaterThan(50);
    expect(humanEdge[2] - humanEdge[0]).toBeLessThan(40);
  });

  it("human style still renders edges and background", async () => {
    const withEdge = await renderDeskOverview({
      style: "human",
      tiles: [
        { id: "a", alias: "A01", label: "左", lifecycle: "ready", x: 0, y: 0, imageBytes: solidPng("#c8b08a") },
        { id: "b", alias: "A02", label: "右", lifecycle: "ready", x: 600, y: 0, imageBytes: solidPng("#8ab0c8") },
      ],
      edges: [{ fromId: "a", toId: "b" }],
    });
    const noEdge = await renderDeskOverview({
      style: "human",
      tiles: [
        { id: "a", alias: "A01", label: "左", lifecycle: "ready", x: 0, y: 0, imageBytes: solidPng("#c8b08a") },
        { id: "b", alias: "A02", label: "右", lifecycle: "ready", x: 600, y: 0, imageBytes: solidPng("#8ab0c8") },
      ],
    });
    expect(withEdge.png.equals(noEdge.png)).toBe(false);
    expect(withEdge.png[0]).toBe(0x89);
  });
});
