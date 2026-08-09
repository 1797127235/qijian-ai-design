import { describe, expect, it, vi } from "vitest";
import { createRemoveFromDeskTool } from "./remove-from-desk.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function snapshotWith(objects: Array<{ id: string; x?: number }>) {
  return {
    project: { id: "p1", name: "t" },
    artifacts: objects.map((o) => ({
      id: o.id,
      artifactType: "effect_image" as const,
      versionId: "v1",
      versionNo: 1,
      status: "draft" as const,
      payload: { file_id: "f1" },
      inputRefs: [],
      createdBy: "agent" as const,
      createdAt: new Date(),
    })),
    deskState: {
      objects: objects.map((o, i) => ({
        artifact_id: o.id,
        kind: "effect_image",
        x: o.x ?? i * 300,
        y: 0,
        rot: 0,
        w: 220,
      })),
      connections: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date(),
    },
  };
}

describe("remove_from_desk", () => {
  it("fails when no ids and no selection", async () => {
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => [],
      ownedCurrent: vi.fn(),
      changed: vi.fn(),
      place: vi.fn(),
      deps: {
        desks: { snapshot: vi.fn().mockResolvedValue(snapshotWith([{ id: "a1" }])) },
        artifacts: { deletePlaced: vi.fn() },
      },
    } as unknown as ToolContext;

    const tool = createRemoveFromDeskTool(ctx);
    const result = await tool.execute("c1", {}, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("未指定");
    expect(ctx.deps.artifacts.deletePlaced).not.toHaveBeenCalled();
  });

  it("deletes selected artifact and emits changed", async () => {
    const deletePlaced = vi.fn().mockResolvedValue({ object: { artifact_id: "a1" } });
    const changed = vi.fn();
    const cancelJob = vi.fn();
    const listActiveByArtifact = vi.fn().mockResolvedValue([
      { id: "job-1", kind: "generate_from_desk" },
    ]);
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => ["a1"],
      ownedCurrent: vi.fn(),
      changed,
      place: vi.fn(),
      deps: {
        desks: { snapshot: vi.fn().mockResolvedValue(snapshotWith([{ id: "a1" }, { id: "a2" }])) },
        artifacts: { deletePlaced },
        jobs: { cancelJob },
        jobStore: { listActiveByArtifact },
      },
    } as unknown as ToolContext;

    const tool = createRemoveFromDeskTool(ctx);
    const result = await tool.execute("c2", {}, undefined, undefined, {} as never);
    expect(deletePlaced).toHaveBeenCalledWith("p1", "a1");
    expect(cancelJob).toHaveBeenCalledWith("job-1");
    expect(changed).toHaveBeenCalledWith("a1", true);
    expect(textOf(result)).toContain("已从桌面删除");
    expect(result.details).toMatchObject({
      ok: true,
      deleted: [expect.objectContaining({ artifact_id: "a1" })],
    });
  });

  it("resolves alias A0x", async () => {
    const deletePlaced = vi.fn().mockResolvedValue({ object: { artifact_id: "uuid-a2" } });
    const snap = snapshotWith([
      { id: "uuid-a1", x: 0 },
      { id: "uuid-a2", x: 300 },
    ]);
    // compileDeskObjects assigns A01, A02 by x order
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => [],
      ownedCurrent: vi.fn(),
      changed: vi.fn(),
      place: vi.fn(),
      deps: {
        desks: { snapshot: vi.fn().mockResolvedValue(snap) },
        artifacts: { deletePlaced },
        jobs: { cancelJob: vi.fn() },
        jobStore: { listActiveByArtifact: vi.fn().mockResolvedValue([]) },
      },
    } as unknown as ToolContext;

    const tool = createRemoveFromDeskTool(ctx);
    const result = await tool.execute(
      "c3",
      { artifact_ids: ["A02"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(deletePlaced).toHaveBeenCalledWith("p1", "uuid-a2");
    expect(textOf(result)).toContain("A02");
  });
});
