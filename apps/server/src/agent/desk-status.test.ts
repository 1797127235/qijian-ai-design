import { describe, expect, it } from "vitest";
import { buildDeskStatusBlock, selectedVisualFileIds } from "./desk-status.js";
import type { DeskSnapshot } from "../domain/types.js";

function snapshot(partial?: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    project: { id: "p1", name: "静安两居" },
    artifacts: [
      {
        id: "note-1",
        artifactType: "sticky_note",
        versionId: "v1",
        versionNo: 1,
        status: "draft",
        payload: { text: "客户喜欢原木色与暖光氛围" },
        inputRefs: [],
        createdBy: "designer",
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        id: "img-1",
        artifactType: "canvas_image",
        versionId: "v2",
        versionNo: 1,
        status: "draft",
        payload: { file_id: "file-img-1" },
        inputRefs: [],
        createdBy: "designer",
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        id: "fx-pending",
        artifactType: "effect_image",
        versionId: "v3",
        versionNo: 1,
        status: "draft",
        payload: { pending: true, prompt: "现代客厅" },
        inputRefs: [],
        createdBy: "agent",
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
    ],
    deskState: {
      objects: [
        { artifact_id: "note-1", kind: "sticky_note", x: 0, y: 0, rot: 0 },
        { artifact_id: "img-1", kind: "canvas_image", x: 10, y: 10, rot: 0 },
        { artifact_id: "fx-pending", kind: "effect_image", x: 20, y: 20, rot: 0 },
      ],
      connections: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    },
    ...partial,
  };
}

describe("buildDeskStatusBlock", () => {
  it("reports unavailable desk state", () => {
    expect(buildDeskStatusBlock(null)).toContain("桌面状态暂不可用");
  });

  it("lists selection and desk objects", () => {
    const block = buildDeskStatusBlock(snapshot(), ["img-1"]);
    expect(block).toContain("项目：静安两居");
    expect(block).toContain("选中（1）：");
    expect(block).toContain("canvas_image img-1");
    expect(block).toContain("sticky_note note-1");
  });

  it("lists multiple selections", () => {
    const block = buildDeskStatusBlock(snapshot(), ["img-1", "note-1"]);
    expect(block).toContain("选中（2）：");
    expect(block).toContain("canvas_image img-1");
    expect(block).toContain("sticky_note note-1");
  });

  it("marks missing selection as invalid", () => {
    const block = buildDeskStatusBlock(snapshot(), ["missing"]);
    expect(block).toContain("无效（missing）");
  });

  it("reports no selection", () => {
    expect(buildDeskStatusBlock(snapshot(), [])).toContain("选中：无");
  });
});

describe("selectedVisualFileIds", () => {
  it("returns file ids for selected images on the desk", () => {
    expect(selectedVisualFileIds(snapshot(), ["img-1", "note-1", "fx-pending"])).toEqual(["file-img-1"]);
  });

  it("ignores invalid or off-desk ids", () => {
    expect(selectedVisualFileIds(snapshot(), ["missing"])).toEqual([]);
  });
});
