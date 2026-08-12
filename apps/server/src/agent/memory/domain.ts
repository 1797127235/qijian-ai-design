export type MemoryFamily =
  | "project_truth"
  | "design_intent"
  | "design_decision"
  | "visual_system"
  | "decision_history"
  | "open_matter"
  | "project_procedure"
  | "generation_learning";

export const MEMORY_FAMILIES: readonly MemoryFamily[] = [
  "project_truth",
  "design_intent",
  "design_decision",
  "visual_system",
  "decision_history",
  "open_matter",
  "project_procedure",
  "generation_learning",
] as const;

export function isMemoryFamily(value: unknown): value is MemoryFamily {
  return typeof value === "string" && (MEMORY_FAMILIES as readonly string[]).includes(value);
}

export type MemoryEntry = {
  stableKey: string;
  family: MemoryFamily;
  summary: string;
  body: string;
  updatedAt: string;
};

export type MemoryState = {
  projectId: string;
  revision: number;
  entries: Record<string, MemoryEntry>;
  compiledContext: string;
};

export type MemoryWriteInput = {
  stableKey: string;
  family: MemoryFamily;
  summary: string;
  body: string;
};

export function emptyMemory(projectId: string): MemoryState {
  return { projectId, revision: 0, entries: {}, compiledContext: "" };
}

export function compileContext(entries: Record<string, MemoryEntry>, revision: number): string {
  const list = Object.values(entries).sort((a, b) => a.stableKey.localeCompare(b.stableKey));
  if (list.length === 0) return `[PROJECT_MEMORY revision=${revision}]\n（空）`;
  const byFamily = new Map<MemoryFamily, MemoryEntry[]>();
  for (const entry of list) {
    const bucket = byFamily.get(entry.family) ?? [];
    bucket.push(entry);
    byFamily.set(entry.family, bucket);
  }
  const labels: Record<MemoryFamily, string> = {
    project_truth: "项目事实",
    design_intent: "设计意图",
    design_decision: "设计决策",
    visual_system: "视觉系统",
    decision_history: "决策历史",
    open_matter: "待决事项",
    project_procedure: "项目流程",
    generation_learning: "生成经验",
  };
  const lines = [`[PROJECT_MEMORY revision=${revision}]`];
  for (const family of Object.keys(labels) as MemoryFamily[]) {
    const items = byFamily.get(family);
    if (!items?.length) continue;
    lines.push(`${labels[family]}：`);
    for (const item of items) {
      lines.push(`- ${item.stableKey}: ${item.summary}`);
      if (item.body.trim() && item.body.trim() !== item.summary.trim()) {
        lines.push(`  ${item.body.trim()}`);
      }
    }
  }
  return lines.join("\n");
}

export function upsertEntry(
  state: MemoryState,
  input: MemoryWriteInput,
  now: Date,
): MemoryState {
  const stableKey = input.stableKey.trim();
  if (!stableKey) throw new Error("stableKey 不能为空");
  if (!isMemoryFamily(input.family)) throw new Error("family 无效");
  const summary = input.summary.trim();
  if (!summary) throw new Error("summary 不能为空");
  const body = input.body.trim() || summary;
  const existing = state.entries[stableKey];
  if (
    existing
    && existing.family === input.family
    && existing.summary === summary
    && existing.body === body
  ) {
    return state;
  }
  const entries = {
    ...state.entries,
    [stableKey]: {
      stableKey,
      family: input.family,
      summary,
      body,
      updatedAt: now.toISOString(),
    },
  };
  const revision = state.revision + 1;
  return {
    projectId: state.projectId,
    revision,
    entries,
    compiledContext: compileContext(entries, revision),
  };
}

export function removeEntry(state: MemoryState, stableKey: string): MemoryState {
  const key = stableKey.trim();
  if (!state.entries[key]) return state;
  const entries = { ...state.entries };
  delete entries[key];
  const revision = state.revision + 1;
  return {
    projectId: state.projectId,
    revision,
    entries,
    compiledContext: compileContext(entries, revision),
  };
}

export function searchEntries(
  state: MemoryState,
  query: string,
  limit = 10,
): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.values(state.entries)
    .map((entry) => {
      const hay = `${entry.stableKey} ${entry.family} ${entry.summary} ${entry.body}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 3;
      for (const token of q.split(/\s+/).filter(Boolean)) {
        if (hay.includes(token)) score += 1;
      }
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.stableKey.localeCompare(b.entry.stableKey))
    .slice(0, Math.min(Math.max(limit, 1), 20))
    .map((row) => row.entry);
}
