import { describe, expect, it } from "vitest";
import { positionFromPointer, screenToWorld, zoomAtPoint } from "./geometry";

describe("desk geometry", () => {
  it("converts screen coordinates into world coordinates", () => {
    expect(screenToWorld({ x: 310, y: 220 }, { x: 10, y: 20 }, { x: 100, y: 50, zoom: 2 })).toEqual({ x: 100, y: 75 });
  });

  it("keeps the grabbed world point under the pointer while dragging", () => {
    expect(positionFromPointer({ x: 180, y: 140 }, { x: 30, y: 20 })).toEqual({ x: 150, y: 120 });
  });

  it("keeps the zoom anchor fixed on screen", () => {
    const before = { x: 40, y: 20, zoom: 0.5 };
    const anchor = { x: 300, y: 200 };
    const worldBefore = screenToWorld(anchor, { x: 0, y: 0 }, before);
    const after = zoomAtPoint(before, anchor, 1);
    const worldAfter = screenToWorld(anchor, { x: 0, y: 0 }, after);

    expect(worldAfter).toEqual(worldBefore);
  });
});
