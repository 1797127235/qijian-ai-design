/**
 * 领域类型（与具体实现解耦，被 services / db schema / http routes 共享）。
 * 命名映射自 CONTEXT.md 的领域词汇。
 */

/** 当前支持的 Artifact 类型；新增类型时必须同时改 payload-rules.ts 的 assertPayload。 */
export const artifactTypes = [
  "sticky_note",
  "canvas_image",
  "effect_image",
] as const;

export type ArtifactType = (typeof artifactTypes)[number];
/** 版本状态仅作元数据，不做产品流程关卡（参考 ADR 关于不强制阶段流程的决策）。 */
export type ArtifactStatus = "draft" | "confirmed";
/** 创建者：区分人与 Agent，用于审计与权限。 */
export type CreatedBy = "designer" | "agent";

/** 桌面上的一个物件：artifact_id 关联 artifact 表，layout 信息只在这里。 */
export interface DeskLayoutObject {
  artifact_id: string;
  /** 冗余字段：与 artifactType 同步，避免前端 list 时 join */
  kind: string;
  x: number;
  y: number;
  rot: number;
  w?: number;
}

/** 物件之间的连线：纯引用，挂在 desk_state.connections；语义由前端解释。 */
export interface DeskConnection {
  id: string;
  from: string;
  to: string;
}

/** 画布视口：x/y 是平移，zoom 是缩放系数。 */
export interface DeskViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 一次 GET /desk 返回的 artifact 详情快照。 */
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

/** 一次 GET /desk 的完整快照（项目 + 全部 artifacts + 桌面状态）。 */
export interface DeskSnapshot {
  project: { id: string; name: string };
  artifacts: ArtifactSnapshot[];
  deskState: { objects: DeskLayoutObject[]; connections: DeskConnection[]; viewport: DeskViewport; updatedAt: Date };
}
