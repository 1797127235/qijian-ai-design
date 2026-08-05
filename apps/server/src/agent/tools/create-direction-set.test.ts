import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./shared.js";
import { createDirectionSetTool } from "./create-direction-set.js";

const directions = [
  { id: "a", title: "A", concept: "A", chips: [] },
  { id: "b", title: "B", concept: "B", chips: [] },
  { id: "c", title: "C", concept: "C", chips: [] },
];

describe("createDirectionSetTool", () => {
  it("uses the atomic artifact-and-layout operation", async () => {
    const createPlaced = vi.fn().mockResolvedValue({ artifact: { id: "artifact-1" } });
    const changed = vi.fn();
    const place = vi.fn();
    const context = {
      projectId: "project-1",
      deps: {
        desks: { snapshot: vi.fn().mockResolvedValue({
          artifacts: [{ artifactType: "understanding_note", status: "confirmed" }],
        }) },
        artifacts: { createPlaced },
      },
      changed,
      place,
    } as unknown as ToolContext;

    const tool = createDirectionSetTool(context);
    await tool.execute("call-1", { directions, x: 100, y: 200 });

    expect(createPlaced).toHaveBeenCalledWith(
      "project-1",
      "design_directions",
      expect.objectContaining({ createdBy: "agent" }),
      { kind: "direction_set", x: 100, y: 200, rot: 0 },
    );
    expect(place).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith("artifact-1");
  });

  it("does not publish a canvas change when the transaction fails", async () => {
    const changed = vi.fn();
    const context = {
      projectId: "project-1",
      deps: {
        desks: { snapshot: vi.fn().mockResolvedValue({
          artifacts: [{ artifactType: "understanding_note", status: "confirmed" }],
        }) },
        artifacts: { createPlaced: vi.fn().mockRejectedValue(new Error("画布写入失败")) },
      },
      changed,
    } as unknown as ToolContext;

    const tool = createDirectionSetTool(context);
    await expect(tool.execute("call-1", { directions, x: 100, y: 200 })).rejects.toThrow("画布写入失败");
    expect(changed).not.toHaveBeenCalled();
  });
});
