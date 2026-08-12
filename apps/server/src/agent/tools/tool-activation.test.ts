import { describe, expect, it } from "vitest";
import {
  NARROW_BASE_TOOLS,
  SEARCH_TOOLS_NAME,
  narrowBaseTools,
  searchToolMatches,
} from "./tool-activation.js";

describe("tool-activation", () => {
  it("narrow base keeps search, look, and bounded resource continuation", () => {
    expect(narrowBaseTools()).toEqual([...NARROW_BASE_TOOLS]);
    expect(narrowBaseTools()).toContain(SEARCH_TOOLS_NAME);
    expect(narrowBaseTools()).toContain("look_at");
    expect(narrowBaseTools()).toContain("read_context_resource");
    expect(narrowBaseTools()).not.toContain("generate_from_desk");
    expect(narrowBaseTools()).not.toContain("remove_from_desk");
    expect(narrowBaseTools()).not.toContain("search_skills");
  });

  it("search matches Chinese generate intent", () => {
    expect(searchToolMatches("生图")).toContain("generate_from_desk");
    expect(searchToolMatches("出三个方向对比")).toContain("generate_from_desk");
    expect(searchToolMatches("删除这张")).toContain("remove_from_desk");
    expect(searchToolMatches("项目记忆")).toContain("inspect_project_memory");
    expect(searchToolMatches("领域 skill")).toContain("search_skills");
    expect(searchToolMatches("加载skill")).toContain("load_skill");
  });

  it("search does not return non-searchable tools", () => {
    expect(searchToolMatches("look")).not.toContain("look_at");
    expect(searchToolMatches("search")).not.toContain(SEARCH_TOOLS_NAME);
    expect(searchToolMatches("resource")).not.toContain("read_context_resource");
  });

});
