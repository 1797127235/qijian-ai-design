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

/** 停靠卡状态：hidden=完全移除（工具栏开关）；collapsed=收成左侧书脊（悬浮展开） */
export type MemoryCardLayout = { hidden: boolean; collapsed: boolean };

export const DEFAULT_MEMORY_CARD_LAYOUT: MemoryCardLayout = { hidden: false, collapsed: false };

const storageKey = (projectId: string) => `desk-memory-card:${projectId}`;

export function loadMemoryCardLayout(projectId: string): MemoryCardLayout {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return { ...DEFAULT_MEMORY_CARD_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<MemoryCardLayout>;
    return { hidden: parsed.hidden === true, collapsed: parsed.collapsed === true };
  } catch {
    return { ...DEFAULT_MEMORY_CARD_LAYOUT };
  }
}

/** 全部条目中最新的 updatedAt；无条目返回 undefined */
export function latestMemoryUpdatedAt(state: ProjectMemoryState): string | undefined {
  let latest: string | undefined;
  for (const entry of Object.values(state.entries)) {
    if (!latest || entry.updatedAt > latest) latest = entry.updatedAt;
  }
  return latest;
}

/** 「3 条 · 刚刚更新」里的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatMemoryRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}

export function saveMemoryCardLayout(projectId: string, layout: MemoryCardLayout): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(layout));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为会话内状态
  }
}
