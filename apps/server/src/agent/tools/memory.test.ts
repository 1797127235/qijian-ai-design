import { describe, expect, it, vi } from "vitest";
import {
  createForgetMemoryTool,
  createInspectProjectMemoryTool,
  createRecordMemoryTool,
  createSearchProjectMemoryTool,
} from "./memory.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function context(memory: Record<string, unknown>): ToolContext {
  return { projectId: "project-1", deps: { memory } } as unknown as ToolContext;
}

describe("minimal project memory Agent tools", () => {
  it("records memory through write()", async () => {
    const write = vi.fn().mockResolvedValue({ revision: 2, entries: {} });
    const tool = createRecordMemoryTool(context({ write }));
    const result = await tool.execute("call-1", {
      stable_key: "materials.primary",
      family: "visual_system",
      summary: "浅木与洞石",
      body: "主材浅木洞石",
    }, undefined, undefined, {} as never);

    expect(write).toHaveBeenCalledWith("project-1", {
      stableKey: "materials.primary",
      family: "visual_system",
      summary: "浅木与洞石",
      body: "主材浅木洞石",
    });
    expect(result.details).toMatchObject({ revision: 2, stable_key: "materials.primary" });
    expect(textOf(result)).toContain("已记录");
  });

  it("inspects and searches current memory", async () => {
    const get = vi.fn().mockResolvedValue({
      revision: 1,
      compiledContext: "[PROJECT_MEMORY revision=1]\n设计意图：\n- intent.mood: 温润安静",
      entries: {},
    });
    const search = vi.fn().mockResolvedValue([{
      family: "design_decision",
      stableKey: "decision.material",
      summary: "采用洞石",
      body: "采用洞石",
      updatedAt: "",
    }]);
    const ctx = context({ get, search });

    const inspected = await createInspectProjectMemoryTool(ctx).execute("call-2", {}, undefined, undefined, {} as never);
    const searched = await createSearchProjectMemoryTool(ctx).execute("call-3", {
      query: "洞石", limit: 5,
    }, undefined, undefined, {} as never);

    expect(textOf(inspected)).toContain("温润安静");
    expect(search).toHaveBeenCalledWith("project-1", "洞石", 5);
    expect(textOf(searched)).toContain("decision.material");
  });

  it("forgets by stable key", async () => {
    const forget = vi.fn().mockResolvedValue({ state: { revision: 3 }, forgotten: true });
    const tool = createForgetMemoryTool(context({ forget }));
    const result = await tool.execute("call-4", {
      stable_key: "materials.primary",
    }, undefined, undefined, {} as never);

    expect(forget).toHaveBeenCalledWith("project-1", "materials.primary");
    expect(result.details).toMatchObject({ revision: 3, stable_key: "materials.primary", forgotten: true });
  });

  it("fails when forgetting a missing key", async () => {
    const forget = vi.fn().mockResolvedValue({ state: { revision: 1 }, forgotten: false });
    const tool = createForgetMemoryTool(context({ forget }));
    const result = await tool.execute("call-5", {
      stable_key: "missing.key",
    }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: false, forgotten: false });
    expect(textOf(result)).toContain("不存在");
  });
});
