import { describe, expect, it } from "vitest";
import { NODE_W_MAX, NODE_W_MIN } from "./connection-geometry";
import { resizeFromHandle } from "./resize-geometry";

const start = { x: 100, y: 50, w: 220, h: 160 };
const aspect = 160 / 220;

describe("resizeFromHandle", () => {
  it("grows from se keeping top-left", () => {
    const next = resizeFromHandle(start, "se", { x: 100 + 440, y: 50 + 320 }, aspect);
    expect(next.x).toBe(100);
    expect(next.y).toBe(50);
    expect(next.w).toBe(440);
  });

  it("grows from e keeping left edge and vertical center", () => {
    const next = resizeFromHandle(start, "e", { x: 100 + 330, y: 50 + 80 }, aspect);
    expect(next.x).toBe(100);
    expect(next.w).toBe(330);
    const h = Math.round(next.w * aspect);
    expect(next.y + h / 2).toBeCloseTo(start.y + start.h / 2, 0);
  });

  it("grows from n keeping bottom and horizontal center", () => {
    const next = resizeFromHandle(start, "n", { x: 100 + 110, y: 50 - 80 }, aspect);
    const h = Math.round(next.w * aspect);
    expect(next.y + h).toBeCloseTo(start.y + start.h, 0);
    expect(next.x + next.w / 2).toBeCloseTo(start.x + start.w / 2, 0);
  });

  it("clamps min/max width", () => {
    expect(resizeFromHandle(start, "se", { x: 101, y: 51 }, aspect).w).toBe(NODE_W_MIN);
    expect(resizeFromHandle(start, "se", { x: 100 + 5000, y: 50 + 5000 }, aspect).w).toBe(NODE_W_MAX);
  });
});
