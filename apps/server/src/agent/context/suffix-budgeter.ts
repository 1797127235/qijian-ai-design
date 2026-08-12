import type { DeskManifestEntry } from "../desk-context.js";

// 当前桌面「全量上下文」帧的硬上限（字符数，按 XML 转义后的长度计）。
// 超过即触发降级：把全量 XML 缩成一份 manifest 列表塞回 prompt，
// 原始全量文本则被外部 caller 存进 resource store，供 agent 按需回拉。
export const MAX_DESK_FULL_CONTEXT_CHARS = 12_000;

export type DeskFullContextBudgetMetrics = Readonly<{
  schema_version: 1;
  max_frame_chars: number;
  truncated: boolean;
  original_text_chars: number;
  original_frame_chars: number;
  emitted_text_chars: number;
  emitted_frame_chars: number;
  saved_frame_chars: number;
  total_objects: number;
  emitted_objects: number;
  omitted_objects: number;
  priority_objects: number;
  resource_status: "not_needed" | "stored" | "unavailable";
  resource_ref?: string;
  next_cursor?: "0";
}>;

export type DeskFullContextBudgetResult = Readonly<{
  text: string;
  metrics: DeskFullContextBudgetMetrics;
}>;

export type DeskFullContextBudgetInput = Readonly<{
  revision: string;
  fullText: string;
  manifest: Readonly<Record<string, DeskManifestEntry>>;
  priorityArtifactIds: readonly string[];
  resourceRef?: string;
}>;

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function xmlTextLength(value: string): number {
  return normalizeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .length;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

// 稳定排序：相同输入必须产生相同顺序，保证降级文本进入 prompt 后
// 不会影响 KV cache 的前缀命中。
function compareEntries(left: DeskManifestEntry, right: DeskManifestEntry): number {
  if (left.alias !== right.alias) return left.alias < right.alias ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function compactEntry(entry: DeskManifestEntry, priority: boolean): string {
  return [
    `- priority=${priority}`,
    `alias=${JSON.stringify(oneLine(entry.alias, 24))}`,
    `id=${JSON.stringify(entry.id)}`,
    `type=${JSON.stringify(oneLine(entry.type, 40))}`,
    `label=${JSON.stringify(oneLine(entry.label, 48))}`,
    `lifecycle=${JSON.stringify(oneLine(entry.lifecycle, 24))}`,
    `grid=${JSON.stringify(oneLine(entry.grid, 24))}`,
  ].join(" ");
}

function renderCompactDesk(
  revision: string,
  totalObjects: number,
  entries: readonly { entry: DeskManifestEntry; priority: boolean }[],
  resourceRef?: string,
): string {
  const omitted = Math.max(0, totalObjects - entries.length);
  const lines = [
    `[DESK_CONTEXT current=true revision=${JSON.stringify(revision)} objects=${totalObjects} budgeted=true emitted_objects=${entries.length} omitted_objects=${omitted}]`,
    ...entries.map(({ entry, priority }) => compactEntry(entry, priority)),
    "[DESK_FULL_TRUNCATED]",
  ];
  if (resourceRef) {
    lines.push(`resource_status=stored resource_ref=${resourceRef} next_cursor=0 omitted_objects=${omitted}`);
  } else {
    lines.push(`resource_status=unavailable omitted_objects=${omitted}`);
  }
  return lines.join("\n");
}

/**
 * Applies the hard budget to the XML-escaped body of a full Desk frame.
 * Focus/Inspect facts remain outside this body in request_context.
 */
export function budgetDeskFullContext(
  input: DeskFullContextBudgetInput,
): DeskFullContextBudgetResult {
  const originalFrameChars = xmlTextLength(input.fullText);
  const allEntries = Object.values(input.manifest);
  const totalObjects = allEntries.length;
  const priorityIds = [...new Set(input.priorityArtifactIds)]
    .filter((id) => Object.hasOwn(input.manifest, id));

  // 路径 A：未超限，原样回填，无 resource 副作用。
  if (originalFrameChars <= MAX_DESK_FULL_CONTEXT_CHARS) {
    return Object.freeze({
      text: input.fullText,
      metrics: Object.freeze({
        schema_version: 1,
        max_frame_chars: MAX_DESK_FULL_CONTEXT_CHARS,
        truncated: false,
        original_text_chars: input.fullText.length,
        original_frame_chars: originalFrameChars,
        emitted_text_chars: input.fullText.length,
        emitted_frame_chars: originalFrameChars,
        saved_frame_chars: 0,
        total_objects: totalObjects,
        emitted_objects: totalObjects,
        omitted_objects: 0,
        priority_objects: priorityIds.length,
        resource_status: "not_needed",
      }),
    });
  }

  // 路径 B：超限，进入贪心填充。
  // 候选顺序 = 优先物件（focus / inspect 等，caller 传入）→ 其余按 alias+id 稳定排序，
  // 这样 priority 物件始终在前面、其余的相对顺序稳定，KV cache 友好。
  const prioritySet = new Set(priorityIds);
  const candidates = [
    ...priorityIds.map((id) => input.manifest[id]),
    ...allEntries.filter((entry) => !prioritySet.has(entry.id)).sort(compareEntries),
  ];
  const emitted: { entry: DeskManifestEntry; priority: boolean }[] = [];

  for (const entry of candidates) {
    const candidate = [...emitted, { entry, priority: prioritySet.has(entry.id) }];
    const candidateText = renderCompactDesk(
      input.revision,
      totalObjects,
      candidate,
      input.resourceRef,
    );
    // 每加一条都重新渲染并按 XML 转义后的字符数校核，避免超限。
    if (xmlTextLength(candidateText) <= MAX_DESK_FULL_CONTEXT_CHARS) emitted.push(candidate.at(-1)!);
  }

  const text = renderCompactDesk(input.revision, totalObjects, emitted, input.resourceRef);
  const emittedFrameChars = xmlTextLength(text);
  if (emittedFrameChars > MAX_DESK_FULL_CONTEXT_CHARS) {
    throw new Error("Desk full context budget metadata exceeds its hard limit");
  }

  // resource_status 三态：
//   not_needed   — 未触发降级，根本没存 resource
//   stored       — 触发降级且原始全文已写入 resource store，agent 可按 next_cursor=0 回拉
//   unavailable  — 触发降级但 resource store 写入失败（或 caller 未提供），只能靠 manifest
  const resourceFields = input.resourceRef
    ? { resource_status: "stored" as const, resource_ref: input.resourceRef, next_cursor: "0" as const }
    : { resource_status: "unavailable" as const };
  return Object.freeze({
    text,
    metrics: Object.freeze({
      schema_version: 1,
      max_frame_chars: MAX_DESK_FULL_CONTEXT_CHARS,
      truncated: true,
      original_text_chars: input.fullText.length,
      original_frame_chars: originalFrameChars,
      emitted_text_chars: text.length,
      emitted_frame_chars: emittedFrameChars,
      saved_frame_chars: Math.max(0, originalFrameChars - emittedFrameChars),
      total_objects: totalObjects,
      emitted_objects: emitted.length,
      omitted_objects: Math.max(0, totalObjects - emitted.length),
      priority_objects: priorityIds.length,
      ...resourceFields,
    }),
  });
}
