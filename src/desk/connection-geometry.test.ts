import { describe, expect, it } from "vitest";
import { bezierPath, nodeSize, sourceAnchor, targetAnchor } from "./connection-geometry";
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

  it("builds a cubic bezier path", () => {
    expect(bezierPath(0, 0, 100, 0)).toContain("C");
    expect(bezierPath(0, 0, 100, 0)).toMatch(/^M 0 0 C /);
  });
});
