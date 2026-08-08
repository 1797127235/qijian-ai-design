import { describe, expect, it } from "vitest";
import {
  bezierPath,
  edgeAnchor,
  nodeAabb,
  nodeSize,
  pickRoute,
  sourceAnchor,
  targetAnchor,
} from "./connection-geometry";
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
  it("honors layout width when present", () => {
    expect(nodeSize({ ...image, w: 440 })).toEqual({ w: 440, h: 320 });
  });

  it("places default source on the right edge center", () => {
    const size = nodeSize(image);
    expect(sourceAnchor(image)).toEqual({ x: 100 + size.w, y: 50 + size.h / 2 });
  });

  it("places default target on the left edge center", () => {
    const size = nodeSize(image);
    expect(targetAnchor(image)).toEqual({ x: 100, y: 50 + size.h / 2 });
  });

  it("exposes four edge anchors", () => {
    const size = nodeSize(image);
    expect(edgeAnchor(image, "top")).toEqual({ x: 100 + size.w / 2, y: 50 });
    expect(edgeAnchor(image, "bottom")).toEqual({ x: 100 + size.w / 2, y: 50 + size.h });
    expect(edgeAnchor(image, "left")).toEqual({ x: 100, y: 50 + size.h / 2 });
    expect(edgeAnchor(image, "right")).toEqual({ x: 100 + size.w, y: 50 + size.h / 2 });
  });

  it("picks bottom→top when target is below", () => {
    const below: DeskObject = { ...image, id: "i2", y: 400 };
    expect(pickRoute(image, below)).toEqual({ fromSide: "bottom", toSide: "top" });
  });

  it("picks right→left when target is to the right", () => {
    const right: DeskObject = { ...image, id: "i2", x: 500 };
    expect(pickRoute(image, right)).toEqual({ fromSide: "right", toSide: "left" });
  });

  it("picks left→right when target is to the left", () => {
    const left: DeskObject = { ...image, id: "i2", x: -400 };
    expect(pickRoute(image, left)).toEqual({ fromSide: "left", toSide: "right" });
  });

  it("picks top→bottom when target is above", () => {
    const above: DeskObject = { ...image, id: "i2", y: -400 };
    expect(pickRoute(image, above)).toEqual({ fromSide: "top", toSide: "bottom" });
  });

  it("rotates anchors with CSS clockwise convention", () => {
    const rotated: DeskObject = { ...image, rot: 90 };
    const size = nodeSize(rotated);
    const cx = image.x + size.w / 2;
    const cy = image.y + size.h / 2;
    expect(sourceAnchor(rotated).x).toBeCloseTo(cx, 5);
    expect(sourceAnchor(rotated).y).toBeCloseTo(cy + size.w / 2, 5);
    expect(targetAnchor(rotated).x).toBeCloseTo(cx, 5);
    expect(targetAnchor(rotated).y).toBeCloseTo(cy - size.w / 2, 5);
  });

  it("expands AABB when rotated", () => {
    const rotated: DeskObject = { ...image, rot: 45 };
    const box = nodeAabb(rotated);
    expect(box.w).toBeGreaterThan(nodeSize(image).w);
    expect(box.h).toBeGreaterThan(nodeSize(image).h);
  });

  it("builds direction-aware cubic bezier (vertical exit)", () => {
    const path = bezierPath(0, 0, 0, 100, "bottom", "top");
    expect(path).toMatch(/^M 0 0 C /);
    // 下出：c1.y > 0；上入：c2.y < 100
    expect(path).toContain("C 0 ");
    const parts = path.replace("M 0 0 C ", "").split(/[ ,]+/).map(Number);
    // c1x c1y c2x c2y ex ey
    expect(parts[0]).toBe(0);
    expect(parts[1]).toBeGreaterThan(0);
    expect(parts[2]).toBe(0);
    expect(parts[3]).toBeLessThan(100);
  });
});
