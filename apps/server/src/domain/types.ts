export const artifactTypes = [
  "design_brief",
  "space_map",
  "understanding_note",
  "design_directions",
  "effect_image",
  "proposal_package",
] as const;

export type ArtifactType = (typeof artifactTypes)[number];
export type ArtifactStatus = "draft" | "confirmed";
export type CreatedBy = "designer" | "agent";
export type PermissionMode = "ask" | "auto";

export interface DeskLayoutObject {
  artifact_id: string;
  kind: string;
  x: number;
  y: number;
  rot: number;
  w?: number;
}

export interface DeskViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ArtifactSnapshot {
  id: string;
  artifactType: ArtifactType;
  versionId: string;
  versionNo: number;
  status: ArtifactStatus;
  payload: Record<string, unknown>;
  inputRefs: unknown[];
  createdBy: CreatedBy;
  createdAt: Date;
}

export interface DeskSnapshot {
  project: { id: string; name: string; permission: PermissionMode };
  artifacts: ArtifactSnapshot[];
  deskState: { objects: DeskLayoutObject[]; viewport: DeskViewport; updatedAt: Date };
}
