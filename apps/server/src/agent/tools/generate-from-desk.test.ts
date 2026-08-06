import { describe, expect, it, vi } from "vitest";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

describe("generate_from_desk", () => {
  it("fails when no source is selected or provided", async () => {
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => [],
      ownedCurrent: vi.fn(),
      changed: vi.fn(),
      deps: { generate: { generate: vi.fn() } },
    } as unknown as ToolContext;

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-1", { prompt: "改成暖色" }, undefined, undefined, {} as never);

    expect(textOf(result)).toContain("未指定源物件");
    expect(ctx.deps.generate.generate).not.toHaveBeenCalled();
  });

  it("uses selected artifact when source_artifact_id omitted", async () => {
    const generate = vi.fn().mockResolvedValue({
      artifact: { id: "fx-1" },
      version: { id: "v1", status: "confirmed" },
      object: { artifact_id: "fx-1", kind: "effect_image", x: 300, y: 40, rot: 0, w: 220 },
      connection: { id: "c1", from: "img-1", to: "fx-1" },
      status: "succeeded",
    });
    const changed = vi.fn();
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => ["img-1"],
      ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
      changed,
      deps: { generate: { generate } },
    } as unknown as ToolContext;

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-2", { prompt: " 改成暖色 " }, undefined, undefined, {} as never);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      sourceArtifactId: "img-1",
      prompt: "改成暖色",
      source: "agent_chat",
      createdBy: "agent",
      clientOpId: "agent:call-2",
    }));
    expect(changed).toHaveBeenCalledWith("fx-1");
    expect(textOf(result)).toContain("已生成效果图并落桌");
    expect(result.details).toMatchObject({ artifact_id: "fx-1", status: "succeeded" });
  });

  it("prefers explicit source_artifact_id over selection", async () => {
    const generate = vi.fn().mockResolvedValue({
      artifact: { id: "fx-2" },
      version: { id: "v2", status: "confirmed" },
      object: { artifact_id: "fx-2", kind: "effect_image", x: 1, y: 2, rot: 0 },
      connection: { id: "c2", from: "img-9", to: "fx-2" },
      status: "succeeded",
    });
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => ["img-1"],
      ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
      changed: vi.fn(),
      deps: { generate: { generate } },
    } as unknown as ToolContext;

    const tool = createGenerateFromDeskTool(ctx);
    await tool.execute("call-3", { prompt: "日式", source_artifact_id: "img-9" }, undefined, undefined, {} as never);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ sourceArtifactId: "img-9" }));
  });

  it("reports generate failure without inventing success", async () => {
    const generate = vi.fn().mockResolvedValue({
      artifact: { id: "fx-fail" },
      version: { id: "v3", status: "draft" },
      object: { artifact_id: "fx-fail", kind: "effect_image", x: 0, y: 0, rot: 0 },
      connection: { id: "c3", from: "img-1", to: "fx-fail" },
      status: "failed",
      error: "timeout",
    });
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => ["img-1"],
      ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
      changed: vi.fn(),
      deps: { generate: { generate } },
    } as unknown as ToolContext;

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute("call-4", { prompt: "现代" }, undefined, undefined, {} as never);

    expect(textOf(result)).toContain("生成失败");
    expect(textOf(result)).toContain("timeout");
    expect(result.details).toMatchObject({ ok: false, status: "failed" });
  });
});
