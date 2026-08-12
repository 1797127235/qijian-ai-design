import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../shared.js";
import { createGenerateFromDeskTool } from "./from-source.js";
import { createReplaceOnDeskTool } from "./replace-on-source.js";
import { createTextToDeskTool } from "./text-to-desk.js";

function context(selected = ["source-1"]) {
  const submitAgentImage = vi.fn().mockResolvedValue({
    taskId: "task-1",
    pending: { artifact: { id: "artifact-1" } },
  });
  const ctx = {
    projectId: "project-1",
    selectedArtifactIds: () => selected,
    ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "project-1" } }),
    changed: vi.fn(),
    place: vi.fn(),
    session: { threadId: "thread-1", runId: () => "run-1" },
    deps: {
      assetTaskSubmitter: { submitAgentImage },
      imageModelOptions: ["model-1"],
    },
  } as unknown as ToolContext;
  return { ctx, submitAgentImage };
}

describe("BullMQ-only generate tools", () => {
  it("allows parallel fan-out for beside/spawn but keeps replace sequential", () => {
    const { ctx } = context();
    expect(createGenerateFromDeskTool(ctx).executionMode).toBe("parallel");
    expect(createTextToDeskTool(ctx).executionMode).toBe("parallel");
    expect(createReplaceOnDeskTool(ctx).executionMode).toBe("sequential");
  });

  it("submits beside and replace tasks with distinct placements", async () => {
    const { ctx, submitAgentImage } = context();

    const beside = await createGenerateFromDeskTool(ctx).execute(
      "call-1", { prompt: "new direction", model: "model-1" }, undefined, undefined, {} as never,
    );
    const replace = await createReplaceOnDeskTool(ctx).execute(
      "call-2", { prompt: "replace it", model: "model-1" }, undefined, undefined, {} as never,
    );

    expect(submitAgentImage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      placement: { mode: "beside", sourceArtifactId: "source-1", referenceArtifactIds: [] },
    }));
    expect(submitAgentImage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      placement: { mode: "replace", sourceArtifactId: "source-1", referenceArtifactIds: [] },
    }));
    expect(beside.details).toMatchObject({ status: "accepted", task_kind: "image.generate" });
    expect(replace.details).toMatchObject({ status: "accepted", replace_in_place: true });
  });

  it("submits text-to-image as a spawn task", async () => {
    const { ctx, submitAgentImage } = context([]);
    const result = await createTextToDeskTool(ctx).execute(
      "call-3", { prompt: "quiet living room", x: 10, y: 20 }, undefined, undefined, {} as never,
    );

    expect(submitAgentImage).toHaveBeenCalledWith(expect.objectContaining({
      placement: { mode: "spawn", referenceArtifactIds: [], x: 10, y: 20 },
    }));
    expect(result.details).toMatchObject({ status: "accepted", task_id: "task-1" });
  });

  it("rejects unknown models before task submission", async () => {
    const { ctx, submitAgentImage } = context();
    const result = await createGenerateFromDeskTool(ctx).execute(
      "call-4", { prompt: "new direction", model: "unknown" }, undefined, undefined, {} as never,
    );

    expect(submitAgentImage).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ ok: false, reason: "unknown_model" });
  });
});
