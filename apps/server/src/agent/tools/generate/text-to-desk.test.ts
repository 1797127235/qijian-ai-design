import { describe, expect, it, vi } from "vitest";
import { createTextToDeskTool } from "./text-to-desk.js";
import type { ToolContext } from "../shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function baseCtx(overrides: Partial<ToolContext> & { deps: ToolContext["deps"] }): ToolContext {
  return {
    projectId: "p1",
    selectedArtifactIds: () => [],
    ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
    changed: vi.fn(),
    place: vi.fn(),
    session: { threadId: "t1", runId: () => "run-1" },
    ...overrides,
  } as ToolContext;
}

describe("text_to_image_on_desk", () => {
  it("accepts without selection and passes spawn placement", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-spawn" },
        version: { id: "v1", status: "draft" },
        object: { artifact_id: "fx-spawn", kind: "effect_image", x: 100, y: 80, rot: 0, w: 220 },
        status: "pending",
      },
      composedPrompt: "现代客厅",
      userPrompt: "现代客厅",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:spawn:agent:call-1",
    });
    const run = vi.fn().mockImplementation(async (opts: {
      prepare: (id: string) => Promise<unknown>;
      input: Record<string, unknown>;
    }) => {
      await opts.prepare("job-spawn");
      return {
        text: "已开始",
        details: {
          ok: true,
          async: true,
          status: "accepted",
          task_id: "job-spawn",
          kind: "generate_from_desk",
          artifact_id: "fx-spawn",
        },
      };
    });

    const ctx = baseCtx({
      deps: { generate: { prepare, complete: vi.fn() }, jobs: { run } } as never,
    });
    const tool = createTextToDeskTool(ctx);
    const result = await tool.execute(
      "call-1",
      { prompt: "现代客厅" },
      undefined,
      undefined,
      {} as never,
    );

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        placement: "spawn",
        tool: "text_to_image_on_desk",
        prompt: "现代客厅",
      }),
    }));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      prompt: "现代客厅",
      source: "agent_chat",
      createdBy: "agent",
    }));
    expect(prepare).toHaveBeenCalledWith(expect.not.objectContaining({
      sourceArtifactId: expect.anything(),
      targetArtifactId: expect.anything(),
    }));
    expect(result.details).toMatchObject({
      placement: "spawn",
      tool: "text_to_image_on_desk",
      replace_in_place: false,
    });
    expect(textOf(result)).toContain("已开始");
  });

  it("passes optional refs and spawnAt", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-2" },
        version: { id: "v2", status: "draft" },
        object: { artifact_id: "fx-2", kind: "effect_image", x: 10, y: 20, rot: 0, w: 220 },
        status: "pending",
      },
      composedPrompt: "木地板氛围",
      userPrompt: "木地板氛围",
      referenceFileIds: ["f1"],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:spawn:x",
    });
    const run = vi.fn().mockImplementation(async (opts: {
      prepare: (id: string) => Promise<unknown>;
    }) => {
      await opts.prepare("job-2");
      return {
        text: "已开始",
        details: { ok: true, async: true, status: "accepted", task_id: "job-2", artifact_id: "fx-2" },
      };
    });
    const ownedCurrent = vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } });
    const ctx = baseCtx({
      ownedCurrent,
      deps: { generate: { prepare, complete: vi.fn() }, jobs: { run } } as never,
    });
    const tool = createTextToDeskTool(ctx);
    await tool.execute(
      "call-2",
      {
        prompt: "木地板氛围",
        reference_artifact_ids: ["ref-1"],
        x: 40,
        y: 60,
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(ownedCurrent).toHaveBeenCalledWith("ref-1");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      referenceArtifactIds: ["ref-1"],
      spawnAt: { x: 40, y: 60 },
    }));
  });

  it("fails when only one of x/y is set", async () => {
    const ctx = baseCtx({
      deps: { generate: { prepare: vi.fn() }, jobs: { run: vi.fn() } } as never,
    });
    const tool = createTextToDeskTool(ctx);
    const result = await tool.execute(
      "call-3",
      { prompt: "x", x: 1 },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(result)).toContain("x 与 y");
    expect(ctx.deps.jobs?.run).not.toHaveBeenCalled();
  });

  it("fails on unknown model", async () => {
    const ctx = baseCtx({
      deps: {
        generate: { prepare: vi.fn() },
        jobs: { run: vi.fn() },
        imageModelOptions: ["grok-a"],
      } as never,
    });
    const tool = createTextToDeskTool(ctx);
    const result = await tool.execute(
      "call-4",
      { prompt: "x", model: "nope" },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(result)).toContain("未知生图 model");
    expect(ctx.deps.jobs?.run).not.toHaveBeenCalled();
  });
});
