import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectMemoryEntry, ProjectMemoryState } from "../lib/api";
import {
  DEFAULT_MEMORY_CARD_LAYOUT,
  groupMemoryEntries,
  loadMemoryCardLayout,
  saveMemoryCardLayout,
} from "./memory";

const entry = (over: Partial<ProjectMemoryEntry>): ProjectMemoryEntry => ({
  stableKey: "k",
  family: "design_decision",
  summary: "s",
  body: "b",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const stateWith = (entries: ProjectMemoryEntry[]): ProjectMemoryState => ({
  projectId: "p1",
  revision: entries.length,
  entries: Object.fromEntries(entries.map((e) => [e.stableKey, e])),
  compiledContext: "",
});

describe("groupMemoryEntries", () => {
  it("按 MEMORY_FAMILIES 顺序输出分区，空分区跳过", () => {
    const sections = groupMemoryEntries(stateWith([
      entry({ stableKey: "a", family: "open_matter" }),
      entry({ stableKey: "b", family: "project_truth" }),
      entry({ stableKey: "c", family: "design_decision" }),
    ]));
    expect(sections.map((s) => s.family)).toEqual(["project_truth", "design_decision", "open_matter"]);
  });

  it("分区内按 updatedAt 倒序", () => {
    const sections = groupMemoryEntries(stateWith([
      entry({ stableKey: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      entry({ stableKey: "new", updatedAt: "2026-03-01T00:00:00.000Z" }),
      entry({ stableKey: "mid", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]));
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.map((e) => e.stableKey)).toEqual(["new", "mid", "old"]);
  });

  it("空记忆返回空数组", () => {
    expect(groupMemoryEntries(stateWith([]))).toEqual([]);
  });
});

describe("memory card layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubStorage = () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    return data;
  };

  it("无记录时返回默认布局", () => {
    stubStorage();
    expect(loadMemoryCardLayout("p-none")).toEqual(DEFAULT_MEMORY_CARD_LAYOUT);
  });

  it("坏 JSON 兜底默认布局", () => {
    const data = stubStorage();
    data.set("desk-memory-card:p-bad", "{oops");
    expect(loadMemoryCardLayout("p-bad")).toEqual(DEFAULT_MEMORY_CARD_LAYOUT);
  });

  it("save 后能 load 回来", () => {
    stubStorage();
    saveMemoryCardLayout("p1", { x: 12, y: 34, hidden: true });
    expect(loadMemoryCardLayout("p1")).toEqual({ x: 12, y: 34, hidden: true });
  });
});
