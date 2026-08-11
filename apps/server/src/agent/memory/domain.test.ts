import { describe, expect, it } from "vitest";
import { compileContext, emptyMemory, removeEntry, searchEntries, upsertEntry } from "./domain.js";

const projectId = "project-1";

describe("minimal project memory domain", () => {
  it("upserts entries and recompiles context", () => {
    let state = emptyMemory(projectId);
    state = upsertEntry(state, {
      stableKey: "materials.primary",
      family: "visual_system",
      summary: "浅木与洞石",
      body: "主材为浅色天然木与哑光洞石",
    }, new Date("2026-08-11T10:00:00.000Z"));

    expect(state.revision).toBe(1);
    expect(state.entries["materials.primary"]?.summary).toBe("浅木与洞石");
    expect(state.compiledContext).toContain("视觉系统");
    expect(state.compiledContext).toContain("浅木与洞石");
  });

  it("overwrites same stable key and keeps only the latest summary in context", () => {
    let state = emptyMemory(projectId);
    state = upsertEntry(state, {
      stableKey: "lighting.temperature",
      family: "visual_system",
      summary: "3000K 暖光",
      body: "3000K 暖光",
    }, new Date("2026-08-11T10:00:00.000Z"));
    state = upsertEntry(state, {
      stableKey: "lighting.temperature",
      family: "visual_system",
      summary: "5000K 冷白光",
      body: "5000K 冷白光",
    }, new Date("2026-08-11T10:01:00.000Z"));

    expect(state.revision).toBe(2);
    expect(Object.keys(state.entries)).toEqual(["lighting.temperature"]);
    expect(state.compiledContext).toContain("5000K 冷白光");
    expect(state.compiledContext).not.toContain("3000K 暖光");
  });

  it("noops identical writes", () => {
    const first = upsertEntry(emptyMemory(projectId), {
      stableKey: "intent.mood",
      family: "design_intent",
      summary: "温润安静",
      body: "温润安静",
    }, new Date("2026-08-11T10:00:00.000Z"));
    const second = upsertEntry(first, {
      stableKey: "intent.mood",
      family: "design_intent",
      summary: "温润安静",
      body: "温润安静",
    }, new Date("2026-08-11T10:02:00.000Z"));

    expect(second.revision).toBe(first.revision);
  });

  it("rejects invalid family on upsert", () => {
    expect(() => upsertEntry(emptyMemory(projectId), {
      stableKey: "x",
      family: "not_a_family" as never,
      summary: "x",
      body: "x",
    }, new Date())).toThrow(/family/);
  });

  it("removes entries and searches by keyword", () => {
    let state = emptyMemory(projectId);
    state = upsertEntry(state, {
      stableKey: "materials.primary",
      family: "visual_system",
      summary: "灰色洞石",
      body: "灰色洞石",
    }, new Date("2026-08-11T10:00:00.000Z"));
    state = upsertEntry(state, {
      stableKey: "intent.mood",
      family: "design_intent",
      summary: "温润安静",
      body: "温润安静",
    }, new Date("2026-08-11T10:01:00.000Z"));

    expect(searchEntries(state, "洞石")).toHaveLength(1);
    state = removeEntry(state, "materials.primary");
    expect(state.entries["materials.primary"]).toBeUndefined();
    expect(compileContext(state.entries, state.revision)).not.toContain("洞石");
  });
});
