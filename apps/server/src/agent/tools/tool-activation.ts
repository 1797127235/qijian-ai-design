/**
 * 发现式工具激活：窄 base + search_tools + policy 重建 + wake 硬名单。
 * 见 docs/ideas/agent-tool-phases.md
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MAX_SELECTED_ARTIFACTS } from "../../domain/selection-limits.js";
import { MAX_INSPECT_IMAGES } from "../desk-context.js";
import { isDebugImageToolEnabled } from "./debug-return-image.js";
import { TEXT_TO_DESK_TOOL_NAME } from "./generate/text-to-desk.js";

export const SEARCH_TOOLS_NAME = "search_tools" as const;

export const NARROW_BASE_TOOLS = [
  SEARCH_TOOLS_NAME,
  "look_at",
  "look_at_desk",
] as const;

/** wake：禁生图 / 禁删除 / 禁 search（防搜回生图） */
export const WAKE_TOOLS = [
  "look_at",
  "look_at_desk",
  "get_task",
  "inspect_project_memory",
  "search_project_memory",
] as const;

export type ToolCatalogEntry = {
  name: string;
  /** 检索用中英文关键词（小写匹配） */
  keywords: string[];
  summary: string;
  /** 写入 system 工具策略段的条目（仅 active 时） */
  policyLines: string[];
  /** 是否可被 search_tools 打开；search_tools / 窄 base 常驻工具为 false */
  searchable: boolean;
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: SEARCH_TOOLS_NAME,
    keywords: ["search", "工具", "发现", "能力"],
    summary: "按意图检索并激活更多桌面工具",
    policyLines: [
      "search_tools：当需要生图、替换、删除、查任务或项目记忆等当前未激活能力时调用；传入简短中文意图。",
      "search 成功后本轮即可使用新工具；不要声称未激活的工具可用。",
    ],
    searchable: false,
  },
  {
    name: "look_at",
    keywords: ["看", "细看", "看图", "验收", "材质", "inspect", "look"],
    summary: "查看指定物件原图像素",
    policyLines: [
      `look_at：未选中或需细看物件时调用（artifact id 或 A01…，最多 ${MAX_INSPECT_IMAGES} 张）。成功返回的图像算 [INSPECT]。`,
    ],
    searchable: false,
  },
  {
    name: "look_at_desk",
    keywords: ["整桌", "桌面", "布局", "总览", "desk"],
    summary: "查看整桌布局总览",
    policyLines: [
      "look_at_desk：需要整桌局面、布局方位或多图编号对齐时调用。desk_overview 不算 [INSPECT]，禁止据此做材质/比例验收。",
    ],
    searchable: false,
  },
  {
    name: "generate_from_desk",
    keywords: [
      "生图", "生成", "效果图", "出图", "再出", "对比", "方向", "旁落", "改一版",
      "generate", "image", "render",
    ],
    summary: "基于主源旁落新效果图",
    policyLines: [
      "generate_from_desk：基于主源在旁边新建效果图。「再出一版 / 旁边对比 / 新方向」。可同一轮并行多次调用（每次一个 prompt）。",
      "多选时必须传 source_artifact_id；reference_artifact_ids 为材质等参考。",
      "异步：accepted+task_id；完成靠 [JOB_EVENT]；禁止说已生成完成；禁止循环 get_task。",
      "并排多方向：同轮多次调用全部提交，建议 2–4 路。",
      "用户点名生图 model 时必须传 model；未知则失败，禁止默默换引擎。",
    ],
    searchable: true,
  },
  {
    name: "replace_on_desk",
    keywords: ["替换", "覆盖", "重生", "原图上改", "replace"],
    summary: "在原卡上覆盖重生",
    policyLines: [
      "replace_on_desk：在指定卡上覆盖重生。「重新生成 / 替换 / 覆盖 / 在原图上改」。对同一卡串行，不要并行多次 replace。",
      "异步：accepted+task_id；完成靠 [JOB_EVENT]。",
    ],
    searchable: true,
  },
  {
    name: TEXT_TO_DESK_TOOL_NAME,
    keywords: ["文生", "空桌", "文字起图", "无主源", "text to image", "spawn"],
    summary: "无主源文生图落桌",
    policyLines: [
      "text_to_image_on_desk：无主源、纯文字（可选参考）新建效果图。空桌起图、不绑旧图的新方向。可并行多次。",
      "有主源要改/衍生时不要用本工具。",
    ],
    searchable: true,
  },
  {
    name: "remove_from_desk",
    keywords: ["删除", "删掉", "清掉", "移除", "delete", "remove"],
    summary: "删除桌面物件（硬删）",
    policyLines: [
      `remove_from_desk：硬删桌面物件，不可恢复。仅用户明确要求删除时调用；一次最多 ${MAX_SELECTED_ARTIFACTS} 个；禁止擅自清空整桌。`,
    ],
    searchable: true,
  },
  {
    name: "get_task",
    keywords: ["任务", "task", "job", "进度", "状态"],
    summary: "查询异步任务状态",
    policyLines: [
      "get_task：仅在用户追问某 task 或 wake 摘要被截断时按需查询；禁止循环轮询。",
    ],
    searchable: true,
  },
  {
    name: "inspect_project_memory",
    keywords: ["记忆", "项目记忆", "当前认知", "inspect memory", "memory"],
    summary: "查看当前项目记忆",
    policyLines: [
      "inspect_project_memory：查看当前项目记忆全文。",
    ],
    searchable: true,
  },
  {
    name: "search_project_memory",
    keywords: ["记忆搜索", "search memory"],
    summary: "搜索项目记忆条目",
    policyLines: [
      "search_project_memory：按关键词搜当前条目。",
    ],
    searchable: true,
  },
  {
    name: "record_project_memory",
    keywords: ["记录记忆", "沉淀", "写记忆", "记住", "record memory"],
    summary: "直接记录项目记忆（立即生效）",
    policyLines: [
      "record_project_memory：写入或覆盖一条项目记忆；同 stable_key 后写覆盖；成功即进后续生图基线。",
      "方向 A/B 未选定前不要写入。",
    ],
    searchable: true,
  },
  {
    name: "forget_project_memory",
    keywords: ["删除记忆", "忘掉", "forget memory"],
    summary: "删除一条项目记忆",
    policyLines: [
      "forget_project_memory：按 stable_key 删除当前记忆条目。",
    ],
    searchable: true,
  },
  {
    name: "debug_return_image",
    keywords: ["debug", "调试图"],
    summary: "调试用返回图像（仅调试开关开启时）",
    policyLines: [
      "debug_return_image：仅调试。",
    ],
    searchable: true,
  },
];

const catalogByName = new Map(TOOL_CATALOG.map((e) => [e.name, e]));

export function enabledCatalog(env: NodeJS.ProcessEnv = process.env): ToolCatalogEntry[] {
  return TOOL_CATALOG.filter((entry) => {
    if (entry.name === "debug_return_image") return isDebugImageToolEnabled(env);
    return true;
  });
}

export function narrowBaseTools(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...NARROW_BASE_TOOLS];
}

export function wakeTools(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...WAKE_TOOLS];
}

/** 简单关键词检索：query 分词后与 keywords/name/summary 匹配。 */
export function searchToolMatches(query: string, catalog: ToolCatalogEntry[] = enabledCatalog()): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean);
  const hay = tokens.length > 0 ? tokens : [q];
  const scored: Array<{ name: string; score: number }> = [];
  for (const entry of catalog) {
    if (!entry.searchable) continue;
    const blob = `${entry.name} ${entry.summary} ${entry.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of hay) {
      if (entry.name.toLowerCase() === t) score += 10;
      else if (entry.keywords.some((k) => k.toLowerCase() === t || k.toLowerCase().includes(t) || t.includes(k.toLowerCase()))) {
        score += 5;
      } else if (blob.includes(t)) score += 2;
    }
    if (score > 0) scored.push({ name: entry.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.map((s) => s.name);
}

export function buildToolPolicy(activeNames: string[]): string {
  const active = [...new Set(activeNames.map((n) => n.trim()).filter(Boolean))];
  const lines: string[] = [
    "## 当前可用工具（仅下列可调用；未列出的不要调用）",
    `active: ${active.join(", ") || "（无）"}`,
  ];
  for (const name of active) {
    const entry = catalogByName.get(name);
    if (!entry) continue;
    for (const line of entry.policyLines) lines.push(`- ${line}`);
  }
  lines.push(
    "- 出图像素仅由已激活的桌面生图工具完成，与对话模型不是同一回事。",
    "- 生图异步：accepted ≠ 完成；完成靠 [JOB_EVENT] / [JOB_EVENT_BATCH]。部分成功须分项说明；禁止自动整批重试。",
    "- 只有工具成功结果或 JOB_EVENT succeeded 才能声称已改桌面。",
    "- 若缺少能力：先 search_tools（若已激活），不要编造工具名。",
  );
  return lines.join("\n");
}

export function composeSystemPrompt(identity: string, activeNames: string[]): string {
  return `${identity.trim()}\n\n${buildToolPolicy(activeNames)}`;
}

/**
 * 激活工具子集并写入与 allowlist 一致的 system（customPrompt 路径不会自动注入 guidelines）。
 */
export function applyToolActivation(
  session: AgentSession,
  toolNames: string[],
  identity: string,
): string[] {
  const names = [...new Set(toolNames.map((n) => n.trim()).filter(Boolean))];
  session.setActiveToolsByName(names);
  const active = session.getActiveToolNames();
  const prompt = composeSystemPrompt(identity, active);
  // setActiveToolsByName 会 rebuild base；customPrompt 短路后仍是旧身份文案。直接写 agent state。
  session.agent.state.systemPrompt = prompt;
  return active;
}

export function mergeActivation(current: string[], additions: string[]): string[] {
  return [...new Set([...current, ...additions])];
}
