import { describe, expect, it } from "vitest";
import {
  NARROW_BASE_TOOLS,
  SEARCH_TOOLS_NAME,
  WAKE_TOOLS,
  buildToolPolicy,
  mergeActivation,
  narrowBaseTools,
  searchToolMatches,
  wakeTools,
} from "./tool-activation.js";

describe("tool-activation", () => {
  it("narrow base is search + look only", () => {
    expect(narrowBaseTools()).toEqual([...NARROW_BASE_TOOLS]);
    expect(narrowBaseTools()).toContain(SEARCH_TOOLS_NAME);
    expect(narrowBaseTools()).toContain("look_at");
    expect(narrowBaseTools()).not.toContain("generate_from_desk");
    expect(narrowBaseTools()).not.toContain("remove_from_desk");
  });

  it("wake excludes generate, replace, remove, and search", () => {
    const wake = wakeTools();
    expect(wake).toEqual([...WAKE_TOOLS]);
    expect(wake).not.toContain(SEARCH_TOOLS_NAME);
    expect(wake).not.toContain("generate_from_desk");
    expect(wake).not.toContain("replace_on_desk");
    expect(wake).not.toContain("text_to_image_on_desk");
    expect(wake).not.toContain("remove_from_desk");
    expect(wake).toContain("look_at");
    expect(wake).toContain("get_task");
  });

  it("search matches Chinese generate intent", () => {
    expect(searchToolMatches("生图")).toContain("generate_from_desk");
    expect(searchToolMatches("出三个方向对比")).toContain("generate_from_desk");
    expect(searchToolMatches("删除这张")).toContain("remove_from_desk");
    expect(searchToolMatches("项目记忆")).toContain("inspect_project_memory");
  });

  it("search does not return non-searchable tools", () => {
    expect(searchToolMatches("look")).not.toContain("look_at");
    expect(searchToolMatches("search")).not.toContain(SEARCH_TOOLS_NAME);
  });

  it("policy only lists active tools", () => {
    const policy = buildToolPolicy(["look_at", "generate_from_desk"]);
    expect(policy).toContain("generate_from_desk");
    expect(policy).toContain("look_at");
    expect(policy).not.toContain("remove_from_desk：");
    expect(policy).toContain("active: look_at, generate_from_desk");
  });

  it("mergeActivation unions unique names", () => {
    expect(mergeActivation(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});
