import { describe, expect, it, vi } from "vitest";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import type { ToolContext } from "./shared.js";

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

describe("generate_from_desk (async job)", () => {
  it("fails when no source is selected or provided", async () => {
    const ctx = baseCtx({
      selectedArtifactIds: () => [],
      deps: { generate: { prepare: vi.fn() }, jobs: { run: vi.fn() } } as never,
    });

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-1", { prompt: "改成暖色" }, undefined, undefined, {} as never);

    expect(textOf(result)).toContain("未指定源物件");
    expect(ctx.deps.jobs?.run).not.toHaveBeenCalled();
  });

  it("returns accepted immediately after prepare and starts background work", async () => {
    const prepared = {
      pending: {
        artifact: { id: "fx-1" },
        version: { id: "v1", status: "draft" },
        object: { artifact_id: "fx-1", kind: "effect_image", x: 300, y: 40, rot: 0, w: 220 },
        connection: { id: "c1", from: "img-1", to: "fx-1" },
        status: "pending" as const,
      },
      composedPrompt: "改成暖色",
      userPrompt: "改成暖色",
      referenceFileIds: [],
      origin: "agent_chat" as const,
      createdBy: "agent" as const,
      lockKey: "p1:img-1",
    };
    const prepare = vi.fn().mockResolvedValue(prepared);
    const complete = vi.fn().mockResolvedValue({ ...prepared.pending, status: "succeeded" });
    const run = vi.fn().mockImplementation(async (opts: {
      prepare: (id: string) => Promise<{ artifactId?: string }>;
      work: (ctx: { signal: AbortSignal }) => Promise<unknown>;
    }) => {
      await opts.prepare("job-1");
      // 不 await work：模拟 runner 后台启动
      void opts.work({ signal: new AbortController().signal });
      return {
        text: "已开始",
        details: {
          ok: true,
          async: true,
          status: "accepted",
          task_id: "job-1",
          kind: "generate_from_desk",
          artifact_id: "fx-1",
        },
      };
    });

    const ctx = baseCtx({
      deps: {
        generate: { prepare, complete },
        jobs: { run },
      } as never,
    });

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-2", { prompt: " 改成暖色 " }, undefined, undefined, {} as never);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ origin: "agent_chat", source_artifact_id: "img-1" }),
    }));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      sourceArtifactId: "img-1",
      prompt: "改成暖色",
      source: "agent_chat",
      createdBy: "agent",
    }));
    expect(textOf(result)).toContain("已开始");
    expect(result.details).toMatchObject({
      ok: true,
      async: true,
      status: "accepted",
      task_id: "job-1",
      artifact_id: "fx-1",
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
  });

  it("prefers explicit source_artifact_id over selection", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-2" },
        version: { id: "v2", status: "draft" },
        object: { artifact_id: "fx-2", kind: "effect_image", x: 1, y: 2, rot: 0 },
        connection: { id: "c2", from: "img-9", to: "fx-2" },
        status: "pending",
      },
      composedPrompt: "日式",
      userPrompt: "日式",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:img-9",
    });
    const run = vi.fn().mockImplementation(async (opts: { prepare: (id: string) => Promise<unknown> }) => {
      await opts.prepare("job-2");
      return {
        text: "已开始",
        details: { ok: true, async: true, status: "accepted", task_id: "job-2", kind: "generate_from_desk", artifact_id: "fx-2" },
      };
    });
    const ctx = baseCtx({
      deps: { generate: { prepare, complete: vi.fn() }, jobs: { run } } as never,
    });

    const tool = createGenerateFromDeskTool(ctx);
    await tool.execute("call-3", { prompt: "日式", source_artifact_id: "img-9" }, undefined, undefined, {} as never);

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ sourceArtifactId: "img-9" }));
  });

  it("reports prepare failure as sync fail", async () => {
    const run = vi.fn().mockRejectedValue(new Error("源物件不在桌面上"));
    const ctx = baseCtx({
      deps: { generate: { prepare: vi.fn() }, jobs: { run } } as never,
    });

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-4", { prompt: "现代" }, undefined, undefined, {} as never);

    expect(textOf(result)).toContain("源物件不在桌面上");
    expect(result.details).toMatchObject({ ok: false });
  });

  it("requires source when multi-selected without source_artifact_id", async () => {
    const ctx = baseCtx({
      selectedArtifactIds: () => ["img-1", "mat-1"],
      deps: { generate: { prepare: vi.fn() }, jobs: { run: vi.fn() } } as never,
    });
    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-5", { prompt: "换地板" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("多选时请指定主图");
    expect(ctx.deps.jobs?.run).not.toHaveBeenCalled();
  });

  it("passes reference ids from selection minus source", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-3" },
        version: { id: "v3", status: "draft" },
        object: { artifact_id: "fx-3", kind: "effect_image", x: 1, y: 2, rot: 0 },
        connection: { id: "c3", from: "img-1", to: "fx-3" },
        status: "pending",
      },
      composedPrompt: "换地板",
      userPrompt: "换地板",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:img-1",
    });
    const run = vi.fn().mockImplementation(async (opts: { prepare: (id: string) => Promise<unknown> }) => {
      await opts.prepare("job-3");
      return {
        text: "已开始",
        details: { ok: true, async: true, status: "accepted", task_id: "job-3", kind: "generate_from_desk", artifact_id: "fx-3" },
      };
    });
    const ctx = baseCtx({
      selectedArtifactIds: () => ["img-1", "mat-1"],
      deps: { generate: { prepare, complete: vi.fn() }, jobs: { run } } as never,
    });
    const tool = createGenerateFromDeskTool(ctx);
    await tool.execute(
      "call-6",
      { prompt: "换地板", source_artifact_id: "img-1" },
      undefined,
      undefined,
      {} as never,
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      sourceArtifactId: "img-1",
      referenceArtifactIds: ["mat-1"],
    }));
  });

  it("forwards allowlisted model to prepare and job input (E2)", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-m" },
        version: { id: "vm", status: "draft" },
        object: { artifact_id: "fx-m", kind: "effect_image", x: 1, y: 2, rot: 0 },
        connection: { id: "cm", from: "img-1", to: "fx-m" },
        status: "pending",
      },
      composedPrompt: "中文说明图",
      userPrompt: "中文说明图",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:img-1",
      model: "gpt-image-2",
    });
    const run = vi.fn().mockImplementation(async (opts: {
      prepare: (id: string) => Promise<unknown>;
      input: Record<string, unknown>;
    }) => {
      await opts.prepare("job-m");
      return {
        text: "已开始",
        details: { ok: true, async: true, status: "accepted", task_id: "job-m", kind: "generate_from_desk", artifact_id: "fx-m" },
      };
    });
    const ctx = baseCtx({
      deps: {
        generate: { prepare, complete: vi.fn() },
        jobs: { run },
        imageModelOptions: ["grok-imagine-image-quality", "gpt-image-2"],
      } as never,
    });
    const tool = createGenerateFromDeskTool(ctx);
    await tool.execute(
      "call-m",
      { prompt: "中文说明图", model: "gpt image2" },
      undefined,
      undefined,
      {} as never,
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-2" }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ model: "gpt-image-2" }),
    }));
  });

  it("fails on unknown model without starting a job (E2)", async () => {
    const run = vi.fn();
    const prepare = vi.fn();
    const ctx = baseCtx({
      deps: {
        generate: { prepare },
        jobs: { run },
        imageModelOptions: ["grok-imagine-image-quality", "gpt-image-2"],
      } as never,
    });
    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute(
      "call-bad-m",
      { prompt: "随便", model: "midjourney-v99" },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(result)).toContain("未知生图 model");
    expect(textOf(result)).toContain("gpt-image-2");
    expect(result.details).toMatchObject({ ok: false, reason: "unknown_model", model: "midjourney-v99" });
    expect(run).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("omits model when not requested so default path stays unchanged", async () => {
    const prepare = vi.fn().mockResolvedValue({
      pending: {
        artifact: { id: "fx-d" },
        version: { id: "vd", status: "draft" },
        object: { artifact_id: "fx-d", kind: "effect_image", x: 1, y: 2, rot: 0 },
        connection: { id: "cd", from: "img-1", to: "fx-d" },
        status: "pending",
      },
      composedPrompt: "默认",
      userPrompt: "默认",
      referenceFileIds: [],
      origin: "agent_chat",
      createdBy: "agent",
      lockKey: "p1:img-1",
    });
    const run = vi.fn().mockImplementation(async (opts: { prepare: (id: string) => Promise<unknown> }) => {
      await opts.prepare("job-d");
      return {
        text: "已开始",
        details: { ok: true, async: true, status: "accepted", task_id: "job-d", kind: "generate_from_desk", artifact_id: "fx-d" },
      };
    });
    const ctx = baseCtx({
      deps: {
        generate: { prepare, complete: vi.fn() },
        jobs: { run },
        imageModelOptions: ["gpt-image-2"],
      } as never,
    });
    const tool = createGenerateFromDeskTool(ctx);
    await tool.execute("call-d", { prompt: "默认" }, undefined, undefined, {} as never);
    expect(prepare).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }));
  });
});
