import { describe, expect, it } from "vitest";
import type { DeskObject } from "./types";
import {
  centerOnMapPoint,
  minimapTransform,
  panByMapDelta,
  toMap,
  viewportRect,
  worldBounds,
} from "./minimap-geometry";

function obj(id: string, x: number, y: number): DeskObject {
  return { id, kind: "canvas_image", x, y, rot: 0, status: "draft" };
}

const MAP = { w: 200, h: 140 };
const CANVAS = { w: 1000, h: 700 };

describe("worldBounds", () => {
  it("empty desk returns a finite default box", () => {
    const b = worldBounds([]);
    for (const v of [b.minX, b.minY, b.maxX, b.maxY]) expect(Number.isFinite(v)).toBe(true);
    expect(b.maxX).toBeGreaterThan(b.minX);
    expect(b.maxY).toBeGreaterThan(b.minY);
  });

  it("covers all objects with padding", () => {
    const b = worldBounds([obj("a", 0, 0), obj("b", 1000, 800)], 0);
    expect(b.minX).toBe(0);
    expect(b.minY).toBe(0);
    // nodeSize 默认 220×160（前端节点尺寸固定）
    expect(b.maxX).toBe(1000 + 220);
    expect(b.maxY).toBe(800 + 160);
  });
});

describe("minimapTransform + toMap", () => {
  it("fits the world into the map preserving aspect", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, MAP);
    // 1000 宽 → scale=0.2；高 500*0.2=100 < 140 垂直居中
    expect(t.scale).toBeCloseTo(0.2);
    const c = toMap(t, 500, 250);
    expect(c.x).toBeCloseTo(100); // 世界中心 → 地图水平中心
    expect(c.y).toBeCloseTo(70); // 垂直也居中
  });

  it("maps world origin to positive offset when bounds start negative", () => {
    const t = minimapTransform({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, MAP);
    const o = toMap(t, -100, -100);
    expect(o.x).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeGreaterThanOrEqual(0);
  });
});

describe("viewportRect", () => {
  it("zoom 翻倍时视口框宽高减半", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 4000, maxY: 2000 }, MAP);
    const v1 = viewportRect({ x: 0, y: 0, zoom: 1 }, CANVAS, t);
    const v2 = viewportRect({ x: 0, y: 0, zoom: 2 }, CANVAS, t);
    expect(v2.w).toBeCloseTo(v1.w / 2);
    expect(v2.h).toBeCloseTo(v1.h / 2);
  });

  it("可见世界区与 screenToWorld 一致（zoom=1 时 1:1）", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 2000, maxY: 1400 }, MAP); // scale=0.1，无居中偏移
    const r = viewportRect({ x: 0, y: 0, zoom: 1 }, CANVAS, t);
    // zoom=1 → 可见世界区 1000×700；scale=0.1 → 100×70
    expect(r.w).toBeCloseTo(100);
    expect(r.h).toBeCloseTo(70);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
  });
});

describe("panByMapDelta", () => {
  it("地图右拖 → 视口左移（看世界右侧），zoom=1 时 1:1/scale", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 2000, maxY: 1400 }, MAP); // scale 0.1
    const next = panByMapDelta({ x: 0, y: 0, zoom: 1 }, 10, 5, t);
    expect(next.x).toBeCloseTo(-100); // 10px map = 100 世界像素
    expect(next.y).toBeCloseTo(-50);
    expect(next.zoom).toBe(1);
  });

  it("zoom=0.5 时同样地图位移只移一半屏幕偏移", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 2000, maxY: 1400 }, MAP);
    const next = panByMapDelta({ x: 0, y: 0, zoom: 0.5 }, 10, 0, t);
    expect(next.x).toBeCloseTo(-50);
  });
});

describe("centerOnMapPoint", () => {
  it("点击后目标世界点位于视口中心", () => {
    const t = minimapTransform({ minX: 0, minY: 0, maxX: 2000, maxY: 2000 }, MAP);
    const mapPt = toMap(t, 800, 600);
    const view = centerOnMapPoint({ x: 0, y: 0, zoom: 0.8 }, mapPt, t, CANVAS);
    // (800,600) 应映射到画布中心 (500,350)
    expect(view.x + 800 * view.zoom).toBeCloseTo(CANVAS.w / 2);
    expect(view.y + 600 * view.zoom).toBeCloseTo(CANVAS.h / 2);
    expect(view.zoom).toBe(0.8);
  });
});
