/**
 * 桌面感知上下文装配（Survey / Focus / Inspect / 指代）。
 * 对齐 docs/agent-desk-*-*.md；
 */
import type { ArtifactSnapshot, DeskSnapshot } from "../domain/types.js";
import { formatCaptionLine } from "../services/image-caption-sanitize.js";

export const DESK_GRID_CELL = 400;
export const MAX_INSPECT_IMAGES = 4;
export const MAX_FOCUS_HOP_EXTRAS = 12;

export type Lifecycle = "empty" | "pending" | "failed" | "ready";

export type DeskContextOptions = {
  fileNames?: Record<string, string>;
  aliases?: Record<string, string>;
  maxInspect?: number;
  /** 用户原文，用于指代消解 */
  userText?: string;
  /**
   * 预加载的 caption（file_id → 已消毒文本）。
   * 仅 core focus 注入；由 session 层批量读 cache，assemble 保持纯函数。
   */
  captions?: Record<string, string>;
};

export type DeskObjectView = {
  id: string;
  alias: string;
  type: string;
  label: string;
  lifecycle: Lifecycle;
  grid: string;
  x: number;
  y: number;
  intentUser?: string;
  intentComposed?: string;
  fileId?: string;
  edgesIn: string[];
  edgesOut: string[];
};

export type DeskManifestEntry = Readonly<{
  id: string;
  alias: string;
  type: string;
  label: string;
  lifecycle: string;
  grid: string;
  x: number;
  y: number;
  fileId?: string;
  edgesIn: readonly string[];
  edgesOut: readonly string[];
}>;

export type InspectIncluded = { artifactId: string; fileId: string };
export type InspectSkipped = {
  artifactId: string;
  reason: "missing" | "off_desk" | "pending" | "empty" | "failed" | "over_budget" | "not_image";
};
export type InspectPlan = { included: InspectIncluded[]; skipped: InspectSkipped[] };
export type InspectImageRef =
  | { artifactId: string; fileId: string; kind: "image"; imageIndex: number }
  | { artifactId: string; fileId: string; kind: "attachment" };

export type ReferenceResolution = {
  utterance: string;
  unique: boolean;
  resolvedIds: string[];
  candidates: { id: string; reason: string }[];
  basis: string;
};

/**
 * 装配旁路报告：供日志 / L-A 评测，默认不注入模型。
 * dropped 形如 inspect:{id}:{reason} | focus_hop:{id}:over_budget | snapshot_unavailable
 */
export type AssemblyMode = "survey" | "focus" | "inspect" | "resolution";

export type AssemblyReport = {
  modes: AssemblyMode[];
  focusIds: string[];
  hop1Ids: string[];
  inspectIds: string[];
  dropped: string[];
};

export type AssembledDeskContext = {
  text: string;
  stateText: string;
  requestText: string;
  manifest: Record<string, DeskManifestEntry>;
  inspectPlan: InspectPlan;
  resolution: ReferenceResolution | null;
  objects: DeskObjectView[];
  revision: string;
  report: AssemblyReport;
};

export function emptyAssemblyReport(partial: Partial<AssemblyReport> = {}): AssemblyReport {
  return {
    modes: partial.modes ?? [],
    focusIds: partial.focusIds ?? [],
    hop1Ids: partial.hop1Ids ?? [],
    inspectIds: partial.inspectIds ?? [],
    dropped: partial.dropped ?? [],
  };
}

// —— 基础 ——

export function lifecycleOf(artifact: ArtifactSnapshot): Lifecycle {
  const payload = artifact.payload;
  if (payload.pending === true) return "pending";
  if (typeof payload.error === "string" && payload.error.length > 0) return "failed";
  if (typeof payload.file_id === "string" && payload.file_id.trim()) return "ready";
  return "empty";
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, "").trim() || name.trim();
}

function clipLabel(raw: string, max = 24): string {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function gridOf(x: number, y: number): string {
  return `@(${Math.round(x / DESK_GRID_CELL)},${Math.round(y / DESK_GRID_CELL)})`;
}

export function revisionOf(snapshot: DeskSnapshot): string {
  const t = snapshot.deskState.updatedAt;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  const versions = snapshot.artifacts.map((a) => a.versionId).sort().join(",");
  let h = 0;
  for (let i = 0; i < versions.length; i++) h = (h * 31 + versions.charCodeAt(i)) | 0;
  return `${ms.toString(36)}_${(h >>> 0).toString(36)}`;
}

function buildLabels(
  onDesk: ArtifactSnapshot[],
  fileNames: Record<string, string>,
  _connections: { from: string; to: string }[],
): Map<string, string> {
  const raw = new Map<string, string>();
  const typeCounters = new Map<string, number>();
  const nextSeq = (key: string) => {
    const n = (typeCounters.get(key) ?? 0) + 1;
    typeCounters.set(key, n);
    return n;
  };

  for (const artifact of onDesk) {
    // display_name 优先（人读 fact）；禁止把血缘串当主名
    const display = typeof artifact.displayName === "string" ? clipLabel(artifact.displayName) : "";
    if (display) {
      raw.set(artifact.id, display);
      continue;
    }

    const life = lifecycleOf(artifact);
    const fileId = typeof artifact.payload.file_id === "string" ? artifact.payload.file_id : "";
    const fileLabel = fileId && fileNames[fileId] ? clipLabel(stripExt(fileNames[fileId])) : "";

    let base: string;
    if (life === "pending") base = `生成中-${nextSeq("pending")}`;
    else if (life === "failed") base = `生成失败-${nextSeq("failed")}`;
    else if (life === "empty") base = `空图-${nextSeq("empty")}`;
    else if (artifact.artifactType === "canvas_image" && fileLabel) base = fileLabel;
    else if (artifact.artifactType === "effect_image") base = `效果图-${nextSeq("fx")}`;
    else base = `画布图-${nextSeq("canvas")}`;
    raw.set(artifact.id, base);
  }

  // 同桌 ephemeral 消歧（不写回 display_name）
  const seen = new Map<string, number>();
  const unique = new Map<string, string>();
  for (const artifact of onDesk) {
    let label = raw.get(artifact.id) ?? artifact.id;
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label = `${label}-${count}`;
    unique.set(artifact.id, label);
  }
  return unique;
}

/** 编译桌上物件视图（含 alias A01…）。 */
/**
 * 编译本轮桌上物件视图。
 * 只遍历 desk_state.objects ∩ artifacts：不在桌上的 artifact（含历史幽灵 id）永不进目录。
 */
export function compileDeskObjects(
  snapshot: DeskSnapshot,
  fileNames: Record<string, string> = {},
  aliases: Record<string, string> = {},
): DeskObjectView[] {
  const byId = new Map(snapshot.artifacts.map((a) => [a.id, a]));
  const connections = snapshot.deskState.connections ?? [];
  const onDeskArts: { art: ArtifactSnapshot; layout: { artifact_id: string; x: number; y: number; kind: string; rot: number } }[] = [];
  for (const o of snapshot.deskState.objects) {
    const art = byId.get(o.artifact_id);
    if (art) onDeskArts.push({ art, layout: o });
  }

  const labels = buildLabels(
    onDeskArts.map((x) => x.art),
    fileNames,
    connections,
  );

  const edgesIn = new Map<string, string[]>();
  const edgesOut = new Map<string, string[]>();
  for (const edge of connections) {
    edgesIn.set(edge.to, [...(edgesIn.get(edge.to) ?? []), edge.from]);
    edgesOut.set(edge.from, [...(edgesOut.get(edge.from) ?? []), edge.to]);
  }

  return onDeskArts.map(({ art, layout }, index) => {
    const fileId = typeof art.payload.file_id === "string" ? art.payload.file_id.trim() : undefined;
    const userPrompt = typeof art.payload.user_prompt === "string" ? art.payload.user_prompt.trim() : "";
    const composed = typeof art.payload.prompt === "string" ? art.payload.prompt.trim() : "";
    return {
      id: art.id,
      alias: aliases[art.id] ?? `A${String(index + 1).padStart(2, "0")}`,
      type: art.artifactType,
      label: labels.get(art.id) ?? art.id,
      lifecycle: lifecycleOf(art),
      grid: gridOf(layout.x, layout.y),
      x: layout.x,
      y: layout.y,
      intentUser: userPrompt || undefined,
      intentComposed: composed || undefined,
      fileId: fileId || undefined,
      edgesIn: edgesIn.get(art.id) ?? [],
      edgesOut: edgesOut.get(art.id) ?? [],
    };
  });
}

export function deskFileIds(snapshot: DeskSnapshot | null | undefined): string[] {
  if (!snapshot) return [];
  return compileDeskObjects(snapshot)
    .map((o) => o.fileId)
    .filter((id): id is string => Boolean(id));
}

// —— Survey ——

function buildDeskStatusBlockValue(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[] = [],
  options: DeskContextOptions = {},
  includeSelection = true,
): string {
  if (!snapshot) {
    return [
      "[DESK_CONTEXT current=true revision=unknown objects=0 connections=0]",
      "桌面状态暂不可用",
    ].join("\n");
  }

  const objects = compileDeskObjects(snapshot, options.fileNames ?? {}, options.aliases ?? {});
  const byId = new Map(objects.map((o) => [o.id, o]));
  const connections = snapshot.deskState.connections ?? [];
  const rev = revisionOf(snapshot);

  const header = [
    "[DESK_CONTEXT",
    "current=true",
    `revision=${rev}`,
    `project=${snapshot.project.id}`,
    `name=${snapshot.project.name}`,
    `objects=${objects.length}`,
    `connections=${connections.length}`,
  ].join(" ") + "]";

  const selectedLines = selectionLines(objects, selectedArtifactIds);

  // Survey 列全桌：无硬编码件数上限；大桌靠 look_at / 工具按需升采样，不在此截断目录。
  const objectLines = objects.length === 0
    ? ["（空桌）"]
    : objects.map((o) => `- ${o.alias} ${o.type} ${o.id}「${o.label}」 ${o.lifecycle} ${o.grid}`);

  const lines = [
    header,
    ...(includeSelection ? selectedLines : []),
    "桌上物件：",
    ...objectLines,
  ];

  if (connections.length > 0) {
    lines.push("连线：");
    for (const edge of connections) {
      const fromA = byId.get(edge.from)?.alias ?? edge.from;
      const toA = byId.get(edge.to)?.alias ?? edge.to;
      lines.push(`- ${fromA} → ${toA} (${edge.from} → ${edge.to})`);
    }
  }

  if (objects.length > 0) {
    lines.push("编号：");
    for (const o of objects) {
      lines.push(`- ${o.alias}=${o.id}`);
    }
  }

  return lines.join("\n");
}

export function buildDeskStatusBlock(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[] = [],
  options: DeskContextOptions = {},
): string {
  return buildDeskStatusBlockValue(snapshot, selectedArtifactIds, options, true);
}

function selectionLines(objects: DeskObjectView[], selectedArtifactIds: string[]): string[] {
  if (selectedArtifactIds.length === 0) return ["选中：无"];
  const byId = new Map(objects.map((object) => [object.id, object]));
  const lines = [`选中（${selectedArtifactIds.length}）：`];
  for (const id of selectedArtifactIds) {
    const object = byId.get(id);
    if (!object) lines.push(`- 无效（${id}）`);
    else lines.push(`- ${object.alias} ${object.type} ${object.id}「${object.label}」 ${object.lifecycle}`);
  }
  return lines;
}

export function formatSelectionBlock(
  objects: DeskObjectView[],
  selectedArtifactIds: string[],
): string {
  return ["[选中]", ...selectionLines(objects, selectedArtifactIds)].join("\n");
}

export function buildDeskStateBlock(
  snapshot: DeskSnapshot | null | undefined,
  options: DeskContextOptions = {},
): string {
  return buildDeskStatusBlockValue(snapshot, [], options, false);
}

export function deskManifestOf(objects: DeskObjectView[]): Record<string, DeskManifestEntry> {
  const entries = [...objects]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((object) => [object.id, {
      id: object.id,
      alias: object.alias,
      type: object.type,
      label: object.label,
      lifecycle: object.lifecycle,
      grid: object.grid,
      x: object.x,
      y: object.y,
      ...(object.fileId ? { fileId: object.fileId } : {}),
      edgesIn: [...object.edgesIn].sort(),
      edgesOut: [...object.edgesOut].sort(),
    }] as const);
  return Object.fromEntries(entries);
}

// —— Inspect ——

export function planInspectSelection(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[],
  options: { maxInspect?: number } = {},
): InspectPlan {
  const maxInspect = options.maxInspect ?? MAX_INSPECT_IMAGES;
  if (!snapshot || selectedArtifactIds.length === 0) return { included: [], skipped: [] };

  const objects = compileDeskObjects(snapshot);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const included: InspectIncluded[] = [];
  const skipped: InspectSkipped[] = [];
  const seenFile = new Set<string>();

  for (const id of selectedArtifactIds) {
    if (!id) continue;
    const obj = byId.get(id);
    if (!obj) {
      // 可能不在桌上
      const art = snapshot.artifacts.find((a) => a.id === id);
      skipped.push({ artifactId: id, reason: art ? "off_desk" : "missing" });
      continue;
    }
    if (obj.type !== "canvas_image" && obj.type !== "effect_image") {
      skipped.push({ artifactId: id, reason: "not_image" });
      continue;
    }
    if (obj.lifecycle === "pending") {
      skipped.push({ artifactId: id, reason: "pending" });
      continue;
    }
    if (obj.lifecycle === "failed") {
      skipped.push({ artifactId: id, reason: "failed" });
      continue;
    }
    if (obj.lifecycle === "empty" || !obj.fileId) {
      skipped.push({ artifactId: id, reason: "empty" });
      continue;
    }
    if (seenFile.has(obj.fileId)) continue;
    if (included.length >= maxInspect) {
      skipped.push({ artifactId: id, reason: "over_budget" });
      continue;
    }
    seenFile.add(obj.fileId);
    included.push({ artifactId: id, fileId: obj.fileId });
  }
  return { included, skipped };
}

export function selectedVisualFileIds(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[],
): string[] {
  return planInspectSelection(snapshot, selectedArtifactIds).included.map((i) => i.fileId);
}

const skipReasonText: Record<InspectSkipped["reason"], string> = {
  missing: "不存在",
  off_desk: "不在桌",
  pending: "生成中",
  empty: "无图",
  failed: "生成失败",
  over_budget: "超出 Inspect 上限",
  not_image: "非图片",
};

export function formatInspectBlock(
  plan: InspectPlan,
  imageStartIndex: number,
  imageRefs?: InspectImageRef[],
  aliasById?: Map<string, string>,
): string {
  if (plan.included.length === 0 && plan.skipped.length === 0) return "";
  const lines = ["[INSPECT]"];
  const refs = imageRefs ?? plan.included.map((item, i) => ({
    artifactId: item.artifactId,
    fileId: item.fileId,
    kind: "image" as const,
    imageIndex: imageStartIndex + i,
  }));
  const name = (id: string) => {
    const a = aliasById?.get(id);
    return a ? `${a} ${id}` : id;
  };
  if (refs.length === 0) {
    lines.push("本轮未附选中原图。");
  } else {
    lines.push("本轮附带原图像素（仅下列 id 可做画面判断）：");
    for (const ref of refs) {
      if (ref.kind === "attachment") {
        lines.push(`- 见附件 file=${ref.fileId} = ${name(ref.artifactId)}`);
      } else {
        lines.push(`- image_${ref.imageIndex} = ${name(ref.artifactId)} file=${ref.fileId}`);
      }
    }
  }
  if (plan.skipped.length > 0) {
    lines.push("未附原图：");
    for (const item of plan.skipped) {
      lines.push(`- ${name(item.artifactId)}（${skipReasonText[item.reason]}）`);
    }
  }
  lines.push("未列入上方可判断列表的物件，不得声称已看清像素细节。");
  return lines.join("\n");
}

// —— Focus ——

function focusIdSet(
  selectedArtifactIds: string[],
  resolution: ReferenceResolution | null,
  objects: DeskObjectView[],
): string[] {
  const onDesk = new Set(objects.map((o) => o.id));
  const ordered: string[] = [];
  const push = (id: string) => {
    if (!onDesk.has(id) || ordered.includes(id)) return;
    ordered.push(id);
  };
  for (const id of selectedArtifactIds) push(id);
  if (resolution?.unique) {
    for (const id of resolution.resolvedIds) push(id);
  }
  return ordered;
}

/** 一跳邻接；超 MAX_FOCUS_HOP_EXTRAS 的邻居进 dropped（仍扫全边，便于 report）。 */
export function expandHop1(
  coreIds: string[],
  objects: DeskObjectView[],
  maxExtras: number = MAX_FOCUS_HOP_EXTRAS,
): { hop1: string[]; droppedOverBudget: string[] } {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const extra: string[] = [];
  const droppedOverBudget: string[] = [];
  const seen = new Set(coreIds);
  for (const id of coreIds) {
    const obj = byId.get(id);
    if (!obj) continue;
    for (const n of [...obj.edgesIn, ...obj.edgesOut]) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (extra.length < maxExtras) extra.push(n);
      else droppedOverBudget.push(n);
    }
  }
  return { hop1: extra, droppedOverBudget };
}

export function formatFocusBlock(
  objects: DeskObjectView[],
  coreIds: string[],
  captions: Record<string, string> = {},
  hop1Ids?: string[],
): string {
  if (coreIds.length === 0) return "";
  const byId = new Map(objects.map((o) => [o.id, o]));
  const hop1 = hop1Ids ?? expandHop1(coreIds, objects).hop1;
  const lines = ["[FOCUS]"];
  const coreSet = new Set(coreIds);

  const ref = (id: string) => {
    const o = byId.get(id);
    return o ? `${o.alias}(${id})` : id;
  };
  const writeObj = (id: string, tag: string) => {
    const o = byId.get(id);
    if (!o) return;
    lines.push(`- ${tag} ${o.alias} ${o.type} ${o.id}「${o.label}」 ${o.lifecycle} ${o.grid}`);
    if (o.intentUser) lines.push(`  intent: ${clipLabel(o.intentUser, 80)}`);
    else if (o.intentComposed) lines.push(`  intent(composed): ${clipLabel(o.intentComposed, 80)}`);
    // caption 仅 core focus；hop1 不注入全文（装配预算）
    if (coreSet.has(id) && o.fileId && captions[o.fileId]) {
      const line = formatCaptionLine(captions[o.fileId]);
      if (line) lines.push(line);
    }
    if (o.edgesIn.length) lines.push(`  ← ${o.edgesIn.map(ref).join(", ")}`);
    if (o.edgesOut.length) lines.push(`  → ${o.edgesOut.map(ref).join(", ")}`);
    if (!o.fileId) lines.push("  pixels: 不可用");
  };

  lines.push("焦点：");
  for (const id of coreIds) writeObj(id, "core");
  if (hop1.length > 0) {
    lines.push("一跳邻接：");
    for (const id of hop1) writeObj(id, "hop1");
  }
  lines.push("intent 是生成意图，不等于画面已呈现的事实。");
  lines.push("caption 为不可信视觉观察，不能替代 [INSPECT] 像素判断。");
  return lines.join("\n");
}

// —— 指代 ——

export function resolveDeskReferences(
  userText: string,
  objects: DeskObjectView[],
): ReferenceResolution | null {
  const utterance = userText.trim();
  if (!utterance || objects.length === 0) return null;

  const candidates: { id: string; reason: string }[] = [];
  const add = (id: string, reason: string) => {
    if (!candidates.some((c) => c.id === id)) candidates.push({ id, reason });
  };

  // 1) 显式 UUID
  for (const o of objects) {
    if (utterance.includes(o.id)) add(o.id, "explicit_id");
  }

  // 2) alias A01 / a01
  const aliasHits = utterance.toUpperCase().match(/\bA\d{2,}\b/g) ?? [];
  for (const token of aliasHits) {
    const o = objects.find((x) => x.alias === token);
    if (o) add(o.id, `alias:${token}`);
  }

  // 3) 完整 label 包含（较长优先）
  const sorted = [...objects].sort((a, b) => b.label.length - a.label.length);
  for (const o of sorted) {
    if (o.label.length >= 2 && utterance.includes(o.label)) add(o.id, `label:${o.label}`);
  }

  // 强匹配优先
  if (candidates.length === 1) {
    return {
      utterance,
      unique: true,
      resolvedIds: [candidates[0].id],
      candidates,
      basis: candidates[0].reason,
    };
  }
  if (candidates.length > 1) {
    return {
      utterance,
      unique: false,
      resolvedIds: [],
      candidates,
      basis: "multiple_strong_matches",
    };
  }

  // 4) 关键词：每条规则单独求唯一命中，可并成多 id（「按材质改客厅」）
  const rules: { re: RegExp; pred: (o: DeskObjectView) => boolean; reason: string }[] = [
    { re: /材质/, pred: (o) => /材质/.test(o.label), reason: "keyword:材质" },
    // 客厅：优先 canvas ready 且 label 含客厅；避免「从 客厅原图 生成」效果图误命中
    {
      re: /客厅/,
      pred: (o) => o.type === "canvas_image" && o.lifecycle === "ready" && /客厅/.test(o.label),
      reason: "keyword:客厅",
    },
    {
      re: /原图|源图/,
      pred: (o) =>
        o.type === "canvas_image"
        && o.lifecycle === "ready"
        && (/原图|源图/.test(o.label) || (o.edgesOut.length > 0 && !/材质/.test(o.label))),
      reason: "keyword:源图",
    },
    { re: /效果图|生成图|改图结果/, pred: (o) => o.type === "effect_image" && o.lifecycle === "ready", reason: "keyword:效果" },
  ];
  const perRuleUnique: { id: string; reason: string }[] = [];
  let anyAmbiguousRule = false;
  const ambiguousIds: { id: string; reason: string }[] = [];
  for (const rule of rules) {
    if (!rule.re.test(utterance)) continue;
    const hits = objects.filter(rule.pred);
    if (hits.length === 1) perRuleUnique.push({ id: hits[0].id, reason: rule.reason });
    else if (hits.length > 1) {
      anyAmbiguousRule = true;
      for (const h of hits) ambiguousIds.push({ id: h.id, reason: rule.reason });
    }
  }
  const uniqueMerged = [...new Map(perRuleUnique.map((w) => [w.id, w])).values()];

  // 各规则均唯一（可多规则 → 多 id）→ unique 集合
  if (uniqueMerged.length >= 1 && !anyAmbiguousRule) {
    return {
      utterance,
      unique: true,
      resolvedIds: uniqueMerged.map((w) => w.id),
      candidates: uniqueMerged,
      basis: uniqueMerged.map((w) => w.reason).join("+"),
    };
  }
  // 任一条规则多命中 → 不静默
  if (anyAmbiguousRule) {
    const all = [...uniqueMerged, ...ambiguousIds];
    const dedup = [...new Map(all.map((w) => [w.id, w])).values()];
    return {
      utterance,
      unique: false,
      resolvedIds: [],
      candidates: dedup,
      basis: "multiple_keyword_matches",
    };
  }

  return null;
}

export function formatResolutionBlock(resolution: ReferenceResolution, objects: DeskObjectView[]): string {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const lines = ["[RESOLUTION]"];
  if (resolution.unique) {
    lines.push(`唯一消解：${resolution.resolvedIds.map((id) => {
      const o = byId.get(id);
      return o ? `${o.alias} ${id}「${o.label}」` : id;
    }).join(", ")}`);
    lines.push(`依据：${resolution.basis}`);
  } else {
    lines.push("无法唯一消解，候选：");
    for (const c of resolution.candidates) {
      const o = byId.get(c.id);
      lines.push(`- ${o ? `${o.alias} ${c.id}「${o.label}」` : c.id}（${c.reason}）`);
    }
    lines.push("请用户确认后再当作唯一源；不得静默单选。");
  }
  return lines.join("\n");
}

// —— 总装配 ——

/** 由 inspect / focus 裁切结果汇总旁路 report（不进模型文本）。 */
export function buildAssemblyReport(input: {
  snapshotOk: boolean;
  focusIds: string[];
  hop1Ids: string[];
  hop1DroppedIds: string[];
  resolution: ReferenceResolution | null;
  inspectPlan: InspectPlan;
}): AssemblyReport {
  const modes: AssemblyMode[] = ["survey"];
  if (input.resolution) modes.push("resolution");
  if (input.focusIds.length > 0) modes.push("focus");
  if (input.inspectPlan.included.length > 0 || input.inspectPlan.skipped.length > 0) {
    modes.push("inspect");
  }

  const dropped: string[] = [];
  if (!input.snapshotOk) dropped.push("snapshot_unavailable");
  for (const id of input.hop1DroppedIds) {
    dropped.push(`focus_hop:${id}:over_budget`);
  }
  for (const s of input.inspectPlan.skipped) {
    dropped.push(`inspect:${s.artifactId}:${s.reason}`);
  }

  return {
    modes,
    focusIds: [...input.focusIds],
    hop1Ids: [...input.hop1Ids],
    inspectIds: input.inspectPlan.included.map((i) => i.artifactId),
    dropped,
  };
}

export function assembleDeskContext(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[] = [],
  options: DeskContextOptions = {},
): AssembledDeskContext {
  if (!snapshot) {
    const inspectPlan: InspectPlan = { included: [], skipped: [] };
    return {
      text: [
        "[DESK_CONTEXT current=true revision=unknown objects=0 connections=0]",
        "桌面状态暂不可用",
      ].join("\n"),
      stateText: [
        "[DESK_CONTEXT current=true revision=unknown objects=0 connections=0]",
        "桌面状态暂不可用",
      ].join("\n"),
      requestText: formatSelectionBlock([], selectedArtifactIds),
      manifest: {},
      inspectPlan,
      resolution: null,
      objects: [],
      revision: "unknown",
      report: buildAssemblyReport({
        snapshotOk: false,
        focusIds: [],
        hop1Ids: [],
        hop1DroppedIds: [],
        resolution: null,
        inspectPlan,
      }),
    };
  }

  const objects = compileDeskObjects(snapshot, options.fileNames ?? {}, options.aliases ?? {});
  const survey = buildDeskStatusBlock(snapshot, selectedArtifactIds, options);
  const resolution = options.userText
    ? resolveDeskReferences(options.userText, objects)
    : null;
  const coreIds = focusIdSet(selectedArtifactIds, resolution, objects);
  const hop = expandHop1(coreIds, objects);
  const focus = formatFocusBlock(objects, coreIds, options.captions ?? {}, hop.hop1);
  const requestText = [
    formatSelectionBlock(objects, selectedArtifactIds),
    resolution ? formatResolutionBlock(resolution, objects) : "",
    focus,
  ].filter(Boolean).join("\n\n");
  // Inspect 计划：选中 + 唯一消解结果
  const inspectCandidateIds = [
    ...selectedArtifactIds,
    ...(resolution?.unique ? resolution.resolvedIds : []),
  ];
  const inspectPlan = planInspectSelection(snapshot, inspectCandidateIds, {
    maxInspect: options.maxInspect,
  });

  const parts = [survey];
  if (resolution) parts.push(formatResolutionBlock(resolution, objects));
  if (focus) parts.push(focus);
  // INSPECT 文本在 session 加载像素后再 format（需 image index）

  return {
    text: parts.filter(Boolean).join("\n\n"),
    stateText: buildDeskStateBlock(snapshot, options),
    requestText,
    manifest: deskManifestOf(objects),
    inspectPlan,
    resolution,
    objects,
    revision: revisionOf(snapshot),
    report: buildAssemblyReport({
      snapshotOk: true,
      focusIds: coreIds,
      hop1Ids: hop.hop1,
      hop1DroppedIds: hop.droppedOverBudget,
      resolution,
      inspectPlan,
    }),
  };
}
