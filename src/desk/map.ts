import type { ArtifactSnapshot, DeskSnapshot } from "../lib/api";
import type { DeskObject, Direction, Space } from "./types";

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

function spacesOf(payload: Record<string, unknown>): Space[] {
  const raw = Array.isArray(payload.spaces) ? payload.spaces : Array.isArray(payload.regions) ? payload.regions : [];
  return raw.flatMap((item): Space[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = text(value.id ?? value.space_id);
    if (!id) return [];
    return [{
      id,
      name: text(value.name, id),
      key: value.key === true || value.is_key_space === true,
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      w: Number(value.w) || 0.1,
      h: Number(value.h) || 0.1,
    }];
  });
}

function directionsOf(payload: Record<string, unknown>): Direction[] {
  const raw = Array.isArray(payload.directions) ? payload.directions : Array.isArray(payload.cards) ? payload.cards : [];
  return raw.flatMap((item): Direction[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = text(value.id ?? value.direction_id);
    if (!id) return [];
    return [{
      id,
      title: text(value.title, id),
      concept: text(value.concept),
      chips: Array.isArray(value.chips) ? value.chips.filter((c): c is string => typeof c === "string") : [],
      tone: ["site", "wood", "cloth", "green"].includes(text(value.tone)) ? (value.tone as Direction["tone"]) : undefined,
    }];
  });
}

function mapArtifact(artifact: ArtifactSnapshot, layout: { x: number; y: number; rot: number; w?: number }): DeskObject | undefined {
  const { payload, status } = artifact;
  const base = { id: artifact.id, x: layout.x, y: layout.y, rot: layout.rot, status };
  switch (artifact.artifactType) {
    case "space_map":
      return { ...base, kind: "plan", w: layout.w ?? 640, sourceFileId: text(payload.source_file_id) || undefined, spaces: spacesOf(payload) };
    case "understanding_note":
      return { ...base, kind: "note", spaceId: text(payload.space_id), who: text(payload.who, "AI 理解"), text: text(payload.text) };
    case "design_directions":
      return { ...base, kind: "direction_set", directions: directionsOf(payload), selectedId: text(payload.selected_direction_id) || undefined };
    case "effect_image":
      return { ...base, kind: "effect_image", spaceId: text(payload.space_id), url: text(payload.url), adopted: payload.adopted === true };
    default:
      return undefined;
  }
}

export function mapSnapshot(snapshot: DeskSnapshot): DeskObject[] {
  return snapshot.deskState.objects.flatMap((layout) => {
    const artifact = snapshot.artifacts.find((a) => a.id === layout.artifact_id);
    if (!artifact) return [];
    const mapped = mapArtifact(artifact, layout);
    return mapped ? [mapped] : [];
  });
}
