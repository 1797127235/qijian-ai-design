import { describe, expect, it } from "vitest";
import type { DeskSnapshot } from "../lib/api";
import { mapSnapshot } from "./map";

const snapshotWith = (
  artifactType: DeskSnapshot["artifacts"][number]["artifactType"],
  payload: Record<string, unknown>,
): DeskSnapshot => ({
  project: { id: "p1", name: "demo" },
  artifacts: [
    {
      id: "a1",
      artifactType,
      versionId: "v1",
      versionNo: 1,
      status: "draft",
      payload,
      inputRefs: [],
      createdBy: "designer",
    },
  ],
  deskState: {
    objects: [{ artifact_id: "a1", kind: artifactType, x: 10, y: 20, rot: 0 }],
    viewport: { x: 40, y: 20, zoom: 0.62 },
  },
});

describe("mapSnapshot", () => {
  it("keeps existing mappings stable (regression)", () => {
    const note = mapSnapshot(snapshotWith("understanding_note", { text: "hi", who: "AI 理解" }));
    expect(note[0]).toMatchObject({ kind: "note", text: "hi", x: 10, y: 20 });
    const directions = mapSnapshot(snapshotWith("design_directions", { directions: [{ id: "d1", title: "T" }] }));
    expect(directions[0]).toMatchObject({ kind: "direction_set" });
    const effect = mapSnapshot(snapshotWith("effect_image", { url: "https://example.com/x.png" }));
    expect(effect[0]).toMatchObject({ kind: "effect_image", url: "https://example.com/x.png" });
  });

  it("maps sticky_note with its text", () => {
    const objects = mapSnapshot(snapshotWith("sticky_note", { text: "记得选砖" }));
    expect(objects[0]).toMatchObject({ kind: "sticky_note", text: "记得选砖", x: 10, y: 20 });
  });

  it("maps empty sticky_note to an empty string", () => {
    const objects = mapSnapshot(snapshotWith("sticky_note", {}));
    expect(objects[0]).toMatchObject({ kind: "sticky_note", text: "" });
  });

  it("maps canvas_image file_id to the file-serving URL", () => {
    const objects = mapSnapshot(snapshotWith("canvas_image", { file_id: "f-123" }));
    expect(objects[0]).toMatchObject({ kind: "canvas_image", url: "/api/files/f-123" });
  });

  it("drops objects whose artifact is missing from the snapshot", () => {
    const snapshot = snapshotWith("sticky_note", { text: "x" });
    snapshot.deskState.objects.push({ artifact_id: "ghost", kind: "sticky_note", x: 0, y: 0, rot: 0 });
    expect(mapSnapshot(snapshot)).toHaveLength(1);
  });
});
