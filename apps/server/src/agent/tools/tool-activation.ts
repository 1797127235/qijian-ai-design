/** 发现式工具目录（纯推荐）；全部产品工具在 session 创建时固定激活，provider-visible system+tools[] 在 epoch 内字节稳定。 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isDebugImageToolEnabled } from "./debug-return-image.js";
import { TEXT_TO_DESK_TOOL_NAME } from "./generate/text-to-desk.js";
import { READ_CONTEXT_RESOURCE_TOOL_NAME } from "./read-context-resource.js";

export const SEARCH_TOOLS_NAME = "search_tools" as const;

export type ToolCatalogEntry = {
  name: string;
  /** 检索用中英文关键词（小写匹配） */
  keywords: string[];
  summary: string;
  /** 是否可被 search_tools 打开；search_tools / 窄 base 常驻工具为 false */
  searchable: boolean;
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: SEARCH_TOOLS_NAME,
    keywords: ["search", "工具", "发现", "能力"],
    summary: "按意图查询桌面能力说明（仅查询，全部工具始终可用）",
    searchable: false,
  },
  {
    name: "look_at",
    keywords: ["看", "细看", "看图", "验收", "材质", "inspect", "look"],
    summary: "查看指定物件原图像素",
    searchable: true,
  },
  {
    name: "look_at_desk",
    keywords: ["整桌", "桌面", "布局", "总览", "desk"],
    summary: "查看整桌布局总览",
    searchable: true,
  },
  {
    name: READ_CONTEXT_RESOURCE_TOOL_NAME,
    keywords: ["resource", "cursor", "继续读取", "分页"],
    summary: "分页读取被预算层截断的工具结果",
    searchable: true,
  },
  {
    name: "search_skills",
    keywords: ["skill", "技能", "配方", "领域知识", "流程", "风格", "视觉语言"],
    summary: "检索领域 skill 元数据",
    searchable: true,
  },
  {
    name: "load_skill",
    keywords: ["加载skill", "load skill", "技能正文"],
    summary: "加载领域 skill 正文",
    searchable: true,
  },
  {
    name: "generate_from_desk",
    keywords: [
      "生图", "生成", "效果图", "出图", "再出", "对比", "方向", "旁落", "改一版",
      "generate", "image", "render",
    ],
    summary: "基于主源旁落新效果图",
    searchable: true,
  },
  {
    name: "replace_on_desk",
    keywords: ["替换", "覆盖", "重生", "原图上改", "replace"],
    summary: "在原卡上覆盖重生",
    searchable: true,
  },
  {
    name: TEXT_TO_DESK_TOOL_NAME,
    keywords: ["文生", "空桌", "文字起图", "无主源", "text to image", "spawn"],
    summary: "无主源文生图落桌",
    searchable: true,
  },
  {
    name: "remove_from_desk",
    keywords: ["删除", "删掉", "清掉", "移除", "delete", "remove"],
    summary: "删除桌面物件（硬删）",
    searchable: true,
  },
  {
    name: "get_task",
    keywords: ["任务", "task", "job", "进度", "状态"],
    summary: "查询异步任务状态",
    searchable: true,
  },
  {
    name: "inspect_project_memory",
    keywords: ["记忆", "项目记忆", "当前认知", "inspect memory", "memory"],
    summary: "查看当前项目记忆",
    searchable: true,
  },
  {
    name: "search_project_memory",
    keywords: ["记忆搜索", "search memory"],
    summary: "搜索项目记忆条目",
    searchable: true,
  },
  {
    name: "record_project_memory",
    keywords: ["记录记忆", "沉淀", "写记忆", "记住", "record memory"],
    summary: "直接记录项目记忆（立即生效）",
    searchable: true,
  },
  {
    name: "forget_project_memory",
    keywords: ["删除记忆", "忘掉", "forget memory"],
    summary: "删除一条项目记忆",
    searchable: true,
  },
  {
    name: "debug_return_image",
    keywords: ["debug", "调试图"],
    summary: "调试用返回图像（仅调试开关开启时）",
    searchable: true,
  },
];

export function enabledCatalog(env: NodeJS.ProcessEnv = process.env): ToolCatalogEntry[] {
  return TOOL_CATALOG.filter((entry) => {
    if (entry.name === "debug_return_image") return isDebugImageToolEnabled(env);
    return true;
  });
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

/**
 * 仅在 session 创建时调用一次：固定激活全量产品工具。
 * setActiveToolsByName 会改变 provider-visible tools[] 并让 pi 按 active 集重建
 * system prompt（拼接各工具 promptSnippet/promptGuidelines）；运行路径再次调用
 * 会使缓存前缀从 system 段起整体失配（基准 r01 断点 #2），因此创建后禁止再调。
 */
export function activateTools(session: AgentSession, toolNames: string[]): string[] {
  const names = [...new Set(toolNames.map((n) => n.trim()).filter(Boolean))];
  session.setActiveToolsByName(names);
  return session.getActiveToolNames();
}
