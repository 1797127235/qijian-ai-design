import { api, type ArtifactSnapshot, type DeskSnapshot } from "../lib/api";
import type { DeskConnection, DeskObject } from "./types";

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** payload.region 形状校验：四个数值字段齐全才透传。 */
function region(payload: Record<string, unknown>) {
  const r = payload.region;
  if (!r || typeof r !== "object") return undefined;
  const { x, y, w, h } = r as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return undefined;
  return { x, y, w, h };
}

/** 图片卡公共字段：prompt / user_prompt / region / reference_file_id。 */
function imageFields(payload: Record<string, unknown>) {
  return {
    pending: payload.pending === true,
    error: typeof payload.error === "string" ? payload.error : undefined,
    prompt: text(payload.prompt) || undefined,
    userPrompt: text(payload.user_prompt) || undefined,
    region: region(payload),
    referenceFileId: text(payload.reference_file_id) || undefined,
  };
}

function mapArtifact(artifact: ArtifactSnapshot, layout: { x: number; y: number; rot: number; w?: number }): DeskObject | undefined {
  const { payload, status } = artifact;
  const base = {
    id: artifact.id,
    x: layout.x,
    y: layout.y,
    rot: layout.rot,
    ...(layout.w && layout.w > 0 ? { w: layout.w } : {}),
    status,
  };
  if (artifact.artifactType === "canvas_image" || artifact.artifactType === "effect_image") {
    const fileId = text(payload.file_id);
    return {
      ...base,
      kind: artifact.artifactType,
      url: fileId ? api.fileUrl(fileId) : undefined,
      ...imageFields(payload),
    };
  }
}

/** 与后端 desk-context compileDeskObjects 一致：桌上顺序 → A01、A02…（仅 Agent 指物，非人读主名）。 */
export function deskAlias(index: number): string {
  return `A${String(index + 1).padStart(2, "0")}`;
}

function clipLabel(raw: string, max = 24): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 无 displayName 时的前端临时标签（与后端 buildLabels 简化对齐）。
 * 禁止使用「从 X 生成-N」血缘串；序号仅本轮桌面 ephemeral，不写库。
 */
function fallbackLabel(
  artifact: ArtifactSnapshot,
  counters: Map<string, number>,
): string {
  const next = (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  };
  const payload = artifact.payload;
  if (payload.pending === true) return `生成中-${next("pending")}`;
  if (typeof payload.error === "string" && payload.error) return `生成失败-${next("failed")}`;
  const fileId = text(payload.file_id);
  if (!fileId) return `空图-${next("empty")}`;
  if (artifact.artifactType === "effect_image") return `效果图-${next("fx")}`;
  return `画布图-${next("canvas")}`;
}

/**
 * desk 快照 → 画布物件列表。
 * label = displayName（人读 fact）?? fallback；同桌重名加 -2/-3 仅展示层。
 */
export function mapSnapshot(snapshot: DeskSnapshot): DeskObject[] {
  let aliasIndex = 0;
  const counters = new Map<string, number>();
  const rawLabels: { obj: DeskObject; label: string }[] = [];

  for (const layout of snapshot.deskState.objects) {
    const artifact = snapshot.artifacts.find((a) => a.id === layout.artifact_id);
    if (!artifact) continue;
    const mapped = mapArtifact(artifact, layout);
    if (!mapped) continue;
    const display = typeof artifact.displayName === "string" ? clipLabel(artifact.displayName) : "";
    const label = display || fallbackLabel(artifact, counters);
    rawLabels.push({
      obj: { ...mapped, alias: deskAlias(aliasIndex), label },
      label,
    });
    aliasIndex += 1;
  }

  // 同桌 ephemeral 消歧（不写回 display_name）
  const seen = new Map<string, number>();
  return rawLabels.map(({ obj, label }) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n > 1 ? { ...obj, label: `${label}-${n}` } : obj;
  });
}

export function mapConnections(snapshot: DeskSnapshot): DeskConnection[] {
  return snapshot.deskState.connections ?? [];
}
