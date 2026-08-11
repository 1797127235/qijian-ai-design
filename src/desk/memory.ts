import type { ProjectMemoryEntry, ProjectMemoryFamily, ProjectMemoryState } from "../lib/api";

/** family 展示元数据：中文名 + 分区排序（与后端 compileContext 的顺序一致） */
export const MEMORY_FAMILIES: { family: ProjectMemoryFamily; label: string }[] = [
  { family: "project_truth", label: "项目事实" },
  { family: "design_intent", label: "设计意图" },
  { family: "design_decision", label: "设计决策" },
  { family: "visual_system", label: "视觉系统" },
  { family: "decision_history", label: "决策历史" },
  { family: "open_matter", label: "待决事项" },
  { family: "project_procedure", label: "项目流程" },
  { family: "generation_learning", label: "生成经验" },
];

export type MemorySection = { family: ProjectMemoryFamily; label: string; entries: ProjectMemoryEntry[] };

/** 按 family 分区：空分区跳过；分区内按 updatedAt 倒序（最近更新在前） */
export function groupMemoryEntries(state: ProjectMemoryState): MemorySection[] {
  const byFamily = new Map<ProjectMemoryFamily, ProjectMemoryEntry[]>();
  for (const entry of Object.values(state.entries)) {
    const bucket = byFamily.get(entry.family) ?? [];
    bucket.push(entry);
    byFamily.set(entry.family, bucket);
  }
  const sections: MemorySection[] = [];
  for (const { family, label } of MEMORY_FAMILIES) {
    const entries = byFamily.get(family);
    if (!entries?.length) continue;
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sections.push({ family, label, entries });
  }
  return sections;
}

export type MemoryCardLayout = { x: number; y: number; hidden: boolean };

/** 默认放在画布原点左侧，避开资产常用区域 */
export const DEFAULT_MEMORY_CARD_LAYOUT: MemoryCardLayout = { x: -400, y: 40, hidden: false };

const storageKey = (projectId: string) => `desk-memory-card:${projectId}`;

export function loadMemoryCardLayout(projectId: string): MemoryCardLayout {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return { ...DEFAULT_MEMORY_CARD_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<MemoryCardLayout>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      return { ...DEFAULT_MEMORY_CARD_LAYOUT };
    }
    return { x: parsed.x, y: parsed.y, hidden: parsed.hidden === true };
  } catch {
    return { ...DEFAULT_MEMORY_CARD_LAYOUT };
  }
}

export function saveMemoryCardLayout(projectId: string, layout: MemoryCardLayout): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(layout));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为会话内状态
  }
}
