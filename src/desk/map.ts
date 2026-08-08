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
  const base = { id: artifact.id, x: layout.x, y: layout.y, rot: layout.rot, status };
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

/** 与后端 desk-context compileDeskObjects 一致：桌上顺序 → A01、A02… */
export function deskAlias(index: number): string {
  return `A${String(index + 1).padStart(2, "0")}`;
}

export function mapSnapshot(snapshot: DeskSnapshot): DeskObject[] {
  let aliasIndex = 0;
  return snapshot.deskState.objects.flatMap((layout) => {
    const artifact = snapshot.artifacts.find((a) => a.id === layout.artifact_id);
    if (!artifact) return [];
    const mapped = mapArtifact(artifact, layout);
    if (!mapped) return [];
    const withAlias = { ...mapped, alias: deskAlias(aliasIndex) };
    aliasIndex += 1;
    return [withAlias];
  });
}

export function mapConnections(snapshot: DeskSnapshot): DeskConnection[] {
  return snapshot.deskState.connections ?? [];
}
