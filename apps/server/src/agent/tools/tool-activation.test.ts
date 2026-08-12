import { describe, expect, it } from "vitest";
import {
  SEARCH_TOOLS_NAME,
  searchToolMatches,
} from "./tool-activation.js";

describe("tool-activation catalog", () => {
  it("search matches Chinese intents across all product capabilities", () => {
    expect(searchToolMatches("生图")).toContain("generate_from_desk");
    expect(searchToolMatches("出三个方向对比")).toContain("generate_from_desk");
    expect(searchToolMatches("删除这张")).toContain("remove_from_desk");
    expect(searchToolMatches("项目记忆")).toContain("inspect_project_memory");
    expect(searchToolMatches("领域 skill")).toContain("search_skills");
    expect(searchToolMatches("加载skill")).toContain("load_skill");
  });

  it("search also recommends always-active perception tools", () => {
    expect(searchToolMatches("看图")).toContain("look_at");
    expect(searchToolMatches("整桌总览")).toContain("look_at_desk");
    expect(searchToolMatches("分页")).toContain("read_context_resource");
  });

  it("never returns search_tools itself", () => {
    expect(searchToolMatches("search")).not.toContain(SEARCH_TOOLS_NAME);
    expect(searchToolMatches("发现")).not.toContain(SEARCH_TOOLS_NAME);
  });
});
