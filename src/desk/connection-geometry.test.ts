import { describe, expect, it } from "vitest";
import { bezierPath, nodeAabb, nodeSize, sourceAnchor, targetAnchor } from "./connection-geometry";
import type { DeskObject } from "./types";

const image: DeskObject = {
  id: "i1",
  kind: "canvas_image",
  x: 100,
  y: 50,
  rot: 0,
  status: "confirmed",
  url: "/api/files/x",
};

describe("connection geometry", () => {
  it("places source on the right edge center", () => {
    const size = nodeSize(image);
    expect(sourceAnchor(image)).toEqual({ x: 100 + size.w, y: 50 + size.h / 2 });
  });

  it("places target on the left edge center", () => {
    const size = nodeSize(image);
    expect(targetAnchor(image)).toEqual({ x: 100, y: 50 + size.h / 2 });
  });

  it("rotates anchors with CSS clockwise convention", () => {
    const rotated: DeskObject = { ...image, rot: 90 };
    const size = nodeSize(rotated);
    const cx = image.x + size.w / 2;
    const cy = image.y + size.h / 2;
    // 90° 顺时针：右缘中点 → 下缘中点
    expect(sourceAnchor(rotated).x).toBeCloseTo(cx, 5);
    expect(sourceAnchor(rotated).y).toBeCloseTo(cy + size.w / 2, 5);
    // 左缘中点 → 上缘中点
    expect(targetAnchor(rotated).x).toBeCloseTo(cx, 5);
    expect(targetAnchor(rotated).y).toBeCloseTo(cy - size.w / 2, 5);
  });

  it("expands AABB when rotated", () => {
    const rotated: DeskObject = { ...image, rot: 45 };
    const box = nodeAabb(rotated);
    expect(box.w).toBeGreaterThan(nodeSize(image).w);
    expect(box.h).toBeGreaterThan(nodeSize(image).h);
  });

  it("builds a cubic bezier path", () => {
    expect(bezierPath(0, 0, 100, 0)).toContain("C");
    expect(bezierPath(0, 0, 100, 0)).toMatch(/^M 0 0 C /);
  });
});
