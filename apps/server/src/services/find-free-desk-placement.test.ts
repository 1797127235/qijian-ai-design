import { describe, expect, it } from "vitest";
import { deskGenerateLockKey, findFreeDeskPlacement } from "./canvas-generate-service.js";

describe("deskGenerateLockKey", () => {
  it("beside uses pending card id, not source", () => {
    expect(deskGenerateLockKey("p1", { pendingArtifactId: "new-fx" })).toBe("p1:new-fx");
  });

  it("replace prefers target over pending", () => {
    expect(deskGenerateLockKey("p1", {
      targetArtifactId: "src-1",
      pendingArtifactId: "src-1",
    })).toBe("p1:src-1");
  });

  it("two beside jobs on same source get different locks", () => {
    const a = deskGenerateLockKey("p1", { pendingArtifactId: "fx-a" });
    const b = deskGenerateLockKey("p1", { pendingArtifactId: "fx-b" });
    expect(a).not.toBe(b);
  });
});


describe("findFreeDeskPlacement", () => {
  it("empty desk: places near viewport center (not covering nothing)", () => {
    const free = findFreeDeskPlacement({
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    // ASSUMED 1200×800 → center 600,400; card 220×160 → top-left ~490,320
    expect(free.w).toBe(220);
    expect(free.x).toBe(Math.round(600 - 110));
    expect(free.y).toBe(Math.round(400 - 80));
  });

  it("preferred coords used when free", () => {
    const free = findFreeDeskPlacement({
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      preferred: { x: 100, y: 50 },
    });
    expect(free.x).toBe(Math.round(100 - 110));
    expect(free.y).toBe(Math.round(50 - 80));
  });

  it("does not stack on existing card at preferred", () => {
    const free = findFreeDeskPlacement({
      objects: [{ x: 0, y: 0, w: 220 }],
      viewport: { x: 0, y: 0, zoom: 1 },
      preferred: { x: 110, y: 80 }, // center of existing card
    });
    // candidate at preferred would be x=-0-ish overlapping; must shift
    expect(free.x === 0 && free.y === 0).toBe(false);
    // should clear 60px gap from [0,0,220,160]
    const overlaps =
      !(free.x + free.w + 60 <= 0
        || 0 + 220 + 60 <= free.x
        || free.y + 160 + 60 <= 0
        || 0 + 160 + 60 <= free.y);
    expect(overlaps).toBe(false);
  });

  it("falls to right of bounding box when ring is packed", () => {
    const objects = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        objects.push({ x: col * 280, y: row * 220, w: 220 });
      }
    }
    const free = findFreeDeskPlacement({
      objects,
      viewport: { x: 0, y: 0, zoom: 1 },
      preferred: { x: 0, y: 0 },
    });
    expect(free.x).toBeGreaterThanOrEqual(8 * 280 - 60);
  });

  it("second beside from same preferred shifts away from first card", () => {
    const source = { x: 0, y: 0, w: 220 };
    const preferred = {
      x: source.x + 220 + 60 + 110,
      y: source.y + 80,
    };
    const first = findFreeDeskPlacement({
      objects: [source],
      viewport: { x: 0, y: 0, zoom: 1 },
      preferred,
    });
    const second = findFreeDeskPlacement({
      objects: [source, { x: first.x, y: first.y, w: first.w }],
      viewport: { x: 0, y: 0, zoom: 1 },
      preferred,
    });
    expect(second.x === first.x && second.y === first.y).toBe(false);
  });
});
