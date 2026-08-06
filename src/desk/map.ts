import { api, type ArtifactSnapshot, type DeskSnapshot } from "../lib/api";
import type { DeskObject, Direction } from "./types";

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

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
    case "understanding_note":
      return { ...base, kind: "note", who: text(payload.who, "AI 理解"), text: text(payload.text) };
    case "design_directions":
      return { ...base, kind: "direction_set", directions: directionsOf(payload) };
    case "effect_image":
      return { ...base, kind: "effect_image", url: text(payload.url) };
    case "sticky_note":
      return { ...base, kind: "sticky_note", text: text(payload.text) };
    case "canvas_image":
      return { ...base, kind: "canvas_image", url: api.fileUrl(text(payload.file_id)) };
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
