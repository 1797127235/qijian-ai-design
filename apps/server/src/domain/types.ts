export const artifactTypes = [
  "understanding_note",
  "design_directions",
  "effect_image",
  "sticky_note",
  "canvas_image",
] as const;

export type ArtifactType = (typeof artifactTypes)[number];
/** 版本状态仅作元数据，不做产品流程关卡。 */
export type ArtifactStatus = "draft" | "confirmed";
export type CreatedBy = "designer" | "agent";

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
  project: { id: string; name: string };
  artifacts: ArtifactSnapshot[];
  deskState: { objects: DeskLayoutObject[]; viewport: DeskViewport; updatedAt: Date };
}
