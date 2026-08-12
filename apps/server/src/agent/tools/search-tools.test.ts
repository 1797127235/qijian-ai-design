import { describe, expect, it } from "vitest";
import { createSearchToolsTool } from "./search-tools.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

const tool = createSearchToolsTool({} as ToolContext);

describe("search_tools 能力说明（纯推荐）", () => {
  it("returns matched capability guidance and points at direct invocation", async () => {
    const result = await tool.execute("call-1", { query: "删除这张" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true, matched: expect.arrayContaining(["remove_from_desk"]) });
    expect(textOf(result)).toContain("remove_from_desk");
    expect(textOf(result)).toContain("直接调用");
  });

  it("recommends perception tools as well", async () => {
    const result = await tool.execute("call-2", { query: "验收材质" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true, matched: expect.arrayContaining(["look_at"]) });
  });

  it("treats zero hits as a normal exploration result, not a failure", async () => {
    const result = await tool.execute("call-3", { query: "量子波动" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true, reason: "no_match", matched: [] });
    expect(textOf(result)).toContain("目录");
  });
});
