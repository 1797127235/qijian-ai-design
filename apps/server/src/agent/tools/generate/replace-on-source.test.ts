import { describe, expect, it, vi } from "vitest";
import { createReplaceOnDeskTool } from "./replace-on-source.js";
import type { ToolContext } from "../shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function baseCtx(overrides: Partial<ToolContext> & { deps: ToolContext["deps"] }): ToolContext {
  return {
    projectId: "p1",
    selectedArtifactIds: () => ["img-1"],
    ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
    changed: vi.fn(),
    place: vi.fn(),
    session: { threadId: "t1", runId: () => "run-1" },
    ...overrides,
  } as ToolContext;
}

describe("replace_on_desk", () => {
  it("passes targetArtifactId equal to source", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "img-1" },
        version: { id: "v9", status: "draft" },
        object: { artifact_id: "img-1", kind: "effect_image", x: 1, y: 2, rot: 0 },
        status: "pending",
      },
      composedPrompt: "再生成",
      userPrompt: "再生成",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:img-1",
    });
    const run = vi.fn().mockImplementation(async (opts: {
      prepare: (id: string) => Promise<unknown>;
      input: Record<string, unknown>;
    }) => {
      await opts.prepare("job-rep");
      return {
        text: "已开始",
        details: {
          ok: true,
          async: true,
          status: "accepted",
          task_id: "job-rep",
          kind: "generate_from_desk",
          artifact_id: "img-1",
        },
      };
    });
    const ctx = baseCtx({
      deps: { generate: { prepare, complete: vi.fn() }, jobs: { run } } as never,
    });
    const tool = createReplaceOnDeskTool(ctx);
    const result = await tool.execute(
      "call-rep",
      { prompt: "重新生成这张" },
      undefined,
      undefined,
      {} as never,
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      sourceArtifactId: "img-1",
      targetArtifactId: "img-1",
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        source_artifact_id: "img-1",
        target_artifact_id: "img-1",
        replace_in_place: true,
        placement: "replace",
        tool: "replace_on_desk",
      }),
    }));
    expect(result.details).toMatchObject({
      placement: "replace",
      tool: "replace_on_desk",
      replace_in_place: true,
    });
  });

  it("fails when no source", async () => {
    const ctx = baseCtx({
      selectedArtifactIds: () => [],
      deps: { generate: { prepare: vi.fn() }, jobs: { run: vi.fn() } } as never,
    });
    const tool = createReplaceOnDeskTool(ctx);
    const result = await tool.execute("call-1", { prompt: "覆盖" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("未指定源物件");
    expect(ctx.deps.jobs?.run).not.toHaveBeenCalled();
  });
});
