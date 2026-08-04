export type ProjectType = "home" | "commercial" | "landscape";

export type ProjectSummary = {
  id: string;
  name: string;
  project_type: ProjectType;
  area_sqm: string | null;
  updated_at: string;
};

export type Artifact<T> = {
  id: string;
  artifact_type: string;
  current_version: {
    id: string;
    version: number;
    status: "draft" | "confirmed" | "superseded";
    payload: T;
    input_refs: Array<{ file_id: string; role: "floor_plan" | "reference_image" | "brief_attachment" }>;
  } | null;
};

export type Versioned<T> = {
  artifactId: string;
  versionId: string;
  payload: T;
  status: "draft" | "confirmed";
};

export type DesignBriefPayload = {
  household: string | null;
  budget: string | null;
  needs: string;
  style: string | null;
};

export type ProjectUnderstandingPayload = {
  project_and_household_summary: { project_summary: string; household_summary: string };
  space_and_room_review: Array<{ name: string; proposed_use: string; relationship_notes: string }>;
  circulation_and_opening_relationships: string[];
  designer_discussion_points: string[];
};

export type DesignDirectionCard = {
  direction_id: string;
  title: string;
  concept: string;
  spatial_strategies: string[];
  key_tradeoffs: string[];
  materials_and_colors: string[];
  furniture_and_lighting: string[];
  lifestyle_fit: string[];
  risks_and_questions: string[];
  distinctions: string[];
};

export type DesignDirectionsPayload = {
  source_geometry_policy: "preserve_source_geometry";
  cards: DesignDirectionCard[];
  selected_direction_id: string | null;
};

export type ConstraintSourceKind = "source_fact" | "design_decision" | "designer_added";
export type ConstraintStrength = "hard" | "soft" | "unresolved";
export type ConstraintModuleId =
  | "geometry_boundaries"
  | "spatial_organization"
  | "circulation_relationships"
  | "function_storage"
  | "materials_colors"
  | "furniture_lighting"
  | "budget_implementation"
  | "open_questions";

export type DesignConstraintItem = {
  constraint_id: string;
  text: string;
  source_kind: ConstraintSourceKind;
  source_ref: string;
  strength: ConstraintStrength;
  designer_edited: boolean;
};
export type DesignConstraintModule = {
  module_id: ConstraintModuleId;
  title: string;
  summary: string;
  items: DesignConstraintItem[];
};
export type DesignConstraintConflict = {
  conflict_id: string;
  text: string;
  related_constraint_ids: string[];
  status: "unresolved" | "resolved";
  resolution: string | null;
};
export type DesignSystemPayload = {
  schema_version: "home_v1";
  language: string;
  source_geometry_policy: "preserve_source_geometry";
  modules: DesignConstraintModule[];
  prohibited_items: DesignConstraintItem[];
  conflicts: DesignConstraintConflict[];
};

export type AiTask = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  task_type: string;
  output_artifact_id: string | null;
  error_message: string | null;
};

export type StoredFile = {
  id: string;
  project_id: string;
  original_filename: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
};

export type NormalizedPoint = { x: number; y: number };
export type SpaceRegion = {
  space_id: string;
  name: string;
  use: string;
  polygon: NormalizedPoint[];
  is_key_space: boolean;
  designer_confirmed: boolean;
};
export type SpaceRelation = {
  relation_id: string;
  from_space_id: string;
  to_space_id: string;
  relation_type: "adjacent" | "circulation" | "visual_connection" | "service" | "material_continuity" | "separation";
  note: string;
};
export type SpaceMapPayload = {
  schema_version: "home_v1";
  source_file_id: string;
  page_index: number;
  upstream: UpstreamVersionRefs;
  spaces: SpaceRegion[];
  relationships: SpaceRelation[];
};
export type UpstreamVersionRefs = {
  design_direction_artifact_id: string;
  design_direction_version_id: string;
  design_system_artifact_id: string;
  design_system_version_id: string;
};
export type ProposalCanvasPayload = {
  schema_version: "home_v1";
  title: string;
  branch_id: string;
  space_map_artifact_id: string;
  space_map_version_id: string;
  upstream: UpstreamVersionRefs;
  key_space_ids: string[];
};
export type SpaceProposalPayload = {
  schema_version: "home_v1";
  proposal_canvas_artifact_id: string;
  proposal_canvas_version_id: string;
  space_map_artifact_id: string;
  space_map_version_id: string;
  space_id: string;
  title: string;
  objective: string;
  usage_scenario: string;
  spatial_strategy: string;
  image_focus: string;
  suggested_views: string[];
  materials_and_furniture: string[];
  lighting_language: string[];
  inherited_constraint_ids: string[];
  prohibited_content: string[];
  review_status: "current" | "needs_review";
};
export type CanvasLayoutNode = {
  layout_node_id: string;
  artifact_id: string;
  node_type: "space_proposal" | "asset_manifest";
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
};
export type CanvasLayoutPayload = {
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasLayoutNode[];
  visible_layers: Array<"floor_plan" | "spaces" | "relationships" | "assets">;
  narrative_order: string[];
};
export type CanvasLayout = {
  id: string;
  project_id: string;
  proposal_canvas_id: string;
  payload: CanvasLayoutPayload;
};

const base = "/api/v1";

async function req<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const detail = Array.isArray(err.detail) ? (err.detail[0] as { msg?: string })?.msg : err.detail;
    throw new Error(typeof detail === "string" ? detail : "请求失败，请稍后重试。");
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  listProjects: () => req<ProjectSummary[]>("/projects", { method: "GET" }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  projectArtifacts: (id: string) => req<Array<Artifact<unknown>>>(`/projects/${id}/artifacts`, { method: "GET" }),
  projectFiles: (id: string) => req<StoredFile[]>(`/projects/${id}/files`, { method: "GET" }),
  fileContentUrl: (fileId: string) => `${base}/files/${fileId}/content`,

  async createProjectWithBrief(input: {
    name: string;
    projectType: ProjectType;
    areaSqm?: number;
    household: string;
    budget: string;
    needs: string;
    style: string;
    sourceFile: File;
    referenceFiles: File[];
  }): Promise<{ projectId: string; briefArtifactId: string }> {
    const project = await req<{ id: string }>("/projects", {
      method: "POST",
      ...json({ name: input.name, project_type: input.projectType, area_sqm: input.areaSqm }),
    });
    const refs: Array<{ file_id: string; role: "floor_plan" | "reference_image" }> = [];
    const upload = async (file: File, role: "floor_plan" | "reference_image") => {
      const body = new FormData();
      body.append("upload", file);
      const stored = await req<{ id: string }>(`/projects/${project.id}/files`, { method: "POST", body });
      refs.push({ file_id: stored.id, role });
    };
    await upload(input.sourceFile, "floor_plan");
    for (const f of input.referenceFiles) await upload(f, "reference_image");
    const brief = await req<{ id: string }>(`/projects/${project.id}/artifacts`, {
      method: "POST",
      ...json({
        artifact_type: "design_brief",
        payload: { household: input.household || null, budget: input.budget || null, needs: input.needs, style: input.style || null },
        input_refs: refs,
        change_reason: "创建项目 Brief",
      }),
    });
    return { projectId: project.id, briefArtifactId: brief.id };
  },

  createUnderstandingTask: (projectId: string, briefArtifactId: string) =>
    req<AiTask>(`/projects/${projectId}/project-understanding-tasks`, { method: "POST", ...json({ brief_artifact_id: briefArtifactId }) }),
  createDirectionsTask: (projectId: string, understandingArtifactId: string) =>
    req<AiTask>(`/projects/${projectId}/design-directions-tasks`, { method: "POST", ...json({ project_understanding_artifact_id: understandingArtifactId }) }),
  createDesignSystemTask: (projectId: string, directionsArtifactId: string) =>
    req<AiTask>(`/projects/${projectId}/design-system-tasks`, { method: "POST", ...json({ design_direction_artifact_id: directionsArtifactId }) }),
  createModuleTask: (projectId: string, designSystemArtifactId: string, moduleId: ConstraintModuleId) =>
    req<AiTask>(`/projects/${projectId}/design-system-module-tasks`, { method: "POST", ...json({ design_system_artifact_id: designSystemArtifactId, module_id: moduleId }) }),
  task: (id: string) => req<AiTask>(`/ai-tasks/${id}`, { method: "GET" }),
  retryTask: (id: string) => req<AiTask>(`/ai-tasks/${id}/retry`, { method: "POST" }),

  artifact: <T>(id: string) => req<Artifact<T>>(`/artifacts/${id}`, { method: "GET" }),
  saveUnderstanding: (artifactId: string, payload: ProjectUnderstandingPayload, status: "draft" | "confirmed") =>
    req<Artifact<ProjectUnderstandingPayload>>(`/artifacts/${artifactId}/project-understanding-versions`, {
      method: "POST",
      ...json({ payload, status, change_reason: status === "confirmed" ? "设计师确认项目理解" : "设计师保存项目理解草稿" }),
    }),
  saveDirections: (artifactId: string, payload: DesignDirectionsPayload, status: "draft" | "confirmed") =>
    req<Artifact<DesignDirectionsPayload>>(`/artifacts/${artifactId}/design-direction-versions`, {
      method: "POST",
      ...json({ payload, status, change_reason: status === "confirmed" ? "设计师确认设计方向" : "设计师保存设计方向草稿" }),
    }),
  saveDesignSystem: (artifactId: string, payload: DesignSystemPayload, status: "draft" | "confirmed") =>
    req<Artifact<DesignSystemPayload>>(`/artifacts/${artifactId}/design-system-versions`, {
      method: "POST",
      ...json({ payload, status, change_reason: status === "confirmed" ? "设计师确认方案约束包" : "设计师保存方案约束草稿" }),
    }),

  canvasLayout: (proposalCanvasId: string) =>
    req<CanvasLayout | null>(`/proposal-canvases/${proposalCanvasId}/layout`, { method: "GET" }),
  saveCanvasLayout: (proposalCanvasId: string, payload: CanvasLayoutPayload) =>
    req<CanvasLayout>(`/proposal-canvases/${proposalCanvasId}/layout`, { method: "PUT", ...json(payload) }),

  createSpaceMap: (projectId: string, payload: SpaceMapPayload, status: "draft" | "confirmed") =>
    req<Artifact<SpaceMapPayload>>(`/projects/${projectId}/space-maps`, {
      method: "POST",
      ...json({ payload, status, change_reason: status === "confirmed" ? "设计师确认空间地图" : "创建空间地图草稿" }),
    }),
  saveSpaceMap: (artifactId: string, payload: SpaceMapPayload, status: "draft" | "confirmed") =>
    req<Artifact<SpaceMapPayload>>(`/artifacts/${artifactId}/space-map-versions`, {
      method: "POST",
      ...json({ payload, status, change_reason: status === "confirmed" ? "确认空间地图" : "保存空间地图草稿" }),
    }),
  createProposalCanvas: (projectId: string, payload: ProposalCanvasPayload) =>
    req<Artifact<ProposalCanvasPayload>>(`/projects/${projectId}/proposal-canvases`, {
      method: "POST",
      ...json({ payload, change_reason: "创建结构化提案画布" }),
    }),
  createSpaceProposal: (projectId: string, payload: SpaceProposalPayload) =>
    req<Artifact<SpaceProposalPayload>>(`/projects/${projectId}/space-proposals`, {
      method: "POST",
      ...json({ payload, status: "draft", change_reason: "创建空间提案卡" }),
    }),
};

export function versionedOf<T>(artifact: Artifact<T> | undefined): Versioned<T> | undefined {
  if (!artifact?.current_version) return undefined;
  return {
    artifactId: artifact.id,
    versionId: artifact.current_version.id,
    payload: artifact.current_version.payload,
    status: artifact.current_version.status === "confirmed" ? "confirmed" : "draft",
  };
}
