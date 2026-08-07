import { api, type ArtifactSnapshot, type DeskSnapshot } from "../lib/api";
import type { DeskConnection, DeskObject } from "./types";

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

function mapArtifact(artifact: ArtifactSnapshot, layout: { x: number; y: number; rot: number; w?: number }): DeskObject | undefined {
  const { payload, status } = artifact;
  const base = { id: artifact.id, x: layout.x, y: layout.y, rot: layout.rot, status };
  switch (artifact.artifactType) {
    case "sticky_note":
      return { ...base, kind: "sticky_note", text: text(payload.text) };
    case "canvas_image": {
      const fileId = text(payload.file_id);
      return {
        ...base,
        kind: "canvas_image",
        url: fileId ? api.fileUrl(fileId) : undefined,
        pending: payload.pending === true,
        error: typeof payload.error === "string" ? payload.error : undefined,
        prompt: text(payload.prompt) || undefined,
      };
    }
    case "effect_image": {
      const pending = payload.pending === true;
      const error = typeof payload.error === "string" ? payload.error : undefined;
      const fileId = text(payload.file_id);
      return {
        ...base,
        kind: "effect_image",
        url: fileId ? api.fileUrl(fileId) : undefined,
        pending,
        error,
        prompt: text(payload.prompt) || undefined,
      };
    }
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

export function mapConnections(snapshot: DeskSnapshot): DeskConnection[] {
  return snapshot.deskState.connections ?? [];
}
