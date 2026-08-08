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
    connections: [],
    viewport: { x: 40, y: 20, zoom: 0.62 },
  },
});

describe("mapSnapshot", () => {
  it("maps canvas_image file_id to the file-serving URL", () => {
    const objects = mapSnapshot(snapshotWith("canvas_image", { file_id: "f-123" }));
    expect(objects[0]).toMatchObject({ kind: "canvas_image", url: "/api/files/f-123" });
  });

  it("maps empty canvas_image placeholder without url", () => {
    const objects = mapSnapshot(snapshotWith("canvas_image", {}));
    expect(objects[0]).toMatchObject({ kind: "canvas_image", url: undefined, pending: false });
  });

  it("maps pending canvas_image with its prompt", () => {
    const objects = mapSnapshot(snapshotWith("canvas_image", { pending: true, prompt: "北欧书房" }));
    expect(objects[0]).toMatchObject({ kind: "canvas_image", url: undefined, pending: true, prompt: "北欧书房" });
  });

  it("maps pending effect_image without url", () => {
    const objects = mapSnapshot(snapshotWith("effect_image", { pending: true, prompt: "现代客厅" }));
    expect(objects[0]).toMatchObject({ kind: "effect_image", pending: true, prompt: "现代客厅" });
  });

  it("maps effect_image file_id to the file-serving URL", () => {
    const objects = mapSnapshot(snapshotWith("effect_image", { file_id: "f-fx", pending: false }));
    expect(objects[0]).toMatchObject({ kind: "effect_image", url: "/api/files/f-fx", pending: false });
  });

  it("maps inpaint fields for retry (user_prompt / region / reference_file_id)", () => {
    const objects = mapSnapshot(snapshotWith("effect_image", {
      pending: false,
      prompt: "局部重绘：…\n换成绿沙发",
      user_prompt: "换成绿沙发",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      reference_file_id: "f-ref",
      inpaint: true,
    }));
    expect(objects[0]).toMatchObject({
      kind: "effect_image",
      prompt: "局部重绘：…\n换成绿沙发",
      userPrompt: "换成绿沙发",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      referenceFileId: "f-ref",
    });
  });

  it("drops objects whose artifact is missing from the snapshot", () => {
    const snapshot = snapshotWith("canvas_image", { file_id: "f-1" });
    snapshot.deskState.objects.push({ artifact_id: "ghost", kind: "canvas_image", x: 0, y: 0, rot: 0 });
    expect(mapSnapshot(snapshot)).toHaveLength(1);
  });

  it("assigns A01… aliases in desk_state.objects order", () => {
    const snap = snapshotWith("canvas_image", { file_id: "f-1" });
    snap.artifacts.push({
      id: "a2",
      artifactType: "effect_image",
      versionId: "v2",
      versionNo: 1,
      status: "draft",
      payload: { file_id: "f-2", pending: false },
      inputRefs: [],
      createdBy: "agent",
    });
    snap.deskState.objects.push({ artifact_id: "a2", kind: "effect_image", x: 100, y: 0, rot: 0 });
    const objects = mapSnapshot(snap);
    expect(objects.map((o) => o.alias)).toEqual(["A01", "A02"]);
  });
});
