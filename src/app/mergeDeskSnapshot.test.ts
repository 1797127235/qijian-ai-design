import { describe, expect, it } from "vitest";
import { mergeDeskSnapshot } from "./mergeDeskSnapshot";
import type { DeskSnapshot } from "../lib/api";

function snap(partial: {
  projectId: string;
  viewport: { x: number; y: number; zoom: number };
  objectId?: string;
}): DeskSnapshot {
  return {
    project: { id: partial.projectId, name: "p" },
    artifacts: [],
    deskState: {
      objects: partial.objectId
        ? [{ artifact_id: partial.objectId, kind: "canvas_image", x: 1, y: 2, rot: 0 }]
        : [],
      connections: [],
      viewport: partial.viewport,
    },
  };
}

describe("mergeDeskSnapshot", () => {
  it("keeps previous viewport on same project by default", () => {
    const prev = snap({ projectId: "a", viewport: { x: 10, y: 20, zoom: 0.5 } });
    const next = snap({
      projectId: "a",
      viewport: { x: 99, y: 99, zoom: 1 },
      objectId: "o1",
    });
    const merged = mergeDeskSnapshot(next, prev);
    expect(merged.deskState.viewport).toEqual({ x: 10, y: 20, zoom: 0.5 });
    expect(merged.deskState.objects).toHaveLength(1);
    expect(merged.deskState.objects[0]?.artifact_id).toBe("o1");
  });

  it("uses server viewport on first load", () => {
    const next = snap({ projectId: "a", viewport: { x: 5, y: 6, zoom: 0.8 } });
    expect(mergeDeskSnapshot(next, undefined).deskState.viewport).toEqual({
      x: 5,
      y: 6,
      zoom: 0.8,
    });
  });

  it("uses server viewport when project changes", () => {
    const prev = snap({ projectId: "a", viewport: { x: 1, y: 1, zoom: 1 } });
    const next = snap({ projectId: "b", viewport: { x: 2, y: 2, zoom: 0.4 } });
    expect(mergeDeskSnapshot(next, prev).deskState.viewport).toEqual({
      x: 2,
      y: 2,
      zoom: 0.4,
    });
  });

  it("can force server viewport", () => {
    const prev = snap({ projectId: "a", viewport: { x: 10, y: 20, zoom: 0.5 } });
    const next = snap({ projectId: "a", viewport: { x: 99, y: 99, zoom: 1 } });
    expect(mergeDeskSnapshot(next, prev, { preserveViewport: false }).deskState.viewport).toEqual({
      x: 99,
      y: 99,
      zoom: 1,
    });
  });
});
