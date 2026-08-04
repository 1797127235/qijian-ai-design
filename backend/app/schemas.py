import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


ProjectType = Literal["home", "commercial", "landscape"]
ArtifactStatus = Literal["draft", "confirmed", "superseded"]
AiTaskStatus = Literal["pending", "running", "succeeded", "failed"]
ConstraintSourceKind = Literal["source_fact", "design_decision", "designer_added"]
ConstraintStrength = Literal["hard", "soft", "unresolved"]
ConstraintConflictStatus = Literal["unresolved", "resolved"]
ConstraintModuleKey = Literal[
    "geometry_boundaries",
    "spatial_organization",
    "circulation_relationships",
    "function_storage",
    "materials_colors",
    "furniture_lighting",
    "budget_implementation",
    "open_questions",
]


class ProjectCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    project_type: ProjectType
    area_sqm: Annotated[Decimal | None, Field(ge=0, max_digits=8, decimal_places=2)] = None


class ProjectRead(ProjectCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class DesignBriefPayload(BaseModel):
    household: Annotated[str | None, Field(max_length=1000)] = None
    budget: Annotated[str | None, Field(max_length=200)] = None
    needs: Annotated[str, Field(min_length=1, max_length=5000)]
    style: Annotated[str | None, Field(max_length=5000)] = None


class ProjectAndHouseholdSummary(BaseModel):
    project_summary: Annotated[str, Field(min_length=1, max_length=3000)]
    household_summary: Annotated[str, Field(min_length=1, max_length=3000)]


class SpaceAndRoomReview(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    proposed_use: Annotated[str, Field(min_length=1, max_length=1000)]
    relationship_notes: Annotated[str, Field(min_length=1, max_length=1500)]


class ProjectUnderstandingPayload(BaseModel):
    project_and_household_summary: ProjectAndHouseholdSummary
    space_and_room_review: list[SpaceAndRoomReview] = Field(min_length=1, max_length=30)
    circulation_and_opening_relationships: list[Annotated[str, Field(min_length=1, max_length=1500)]] = Field(
        min_length=1, max_length=30
    )
    designer_discussion_points: list[Annotated[str, Field(min_length=1, max_length=1500)]] = Field(
        default_factory=list, max_length=20
    )


class FileReference(BaseModel):
    file_id: uuid.UUID
    role: Literal["floor_plan", "reference_image", "brief_attachment"]


class ArtifactCreate(BaseModel):
    artifact_type: Literal["design_brief"]
    payload: DesignBriefPayload
    input_refs: list[FileReference] = Field(default_factory=list)
    change_reason: Annotated[str | None, Field(max_length=1000)] = None


class ArtifactVersionCreate(BaseModel):
    payload: DesignBriefPayload
    input_refs: list[FileReference] = Field(default_factory=list)
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class ProjectUnderstandingVersionCreate(BaseModel):
    payload: ProjectUnderstandingPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class DesignDirectionCard(BaseModel):
    direction_id: Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_-]+$")]
    title: Annotated[str, Field(min_length=1, max_length=20)]
    concept: Annotated[str, Field(min_length=1, max_length=80)]
    spatial_strategies: list[Annotated[str, Field(min_length=1, max_length=240)]] = Field(
        min_length=3, max_length=5
    )
    key_tradeoffs: list[Annotated[str, Field(min_length=1, max_length=240)]] = Field(
        min_length=2, max_length=3
    )
    materials_and_colors: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        min_length=3, max_length=6
    )
    furniture_and_lighting: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(
        min_length=3, max_length=6
    )
    lifestyle_fit: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=2
    )
    risks_and_questions: list[Annotated[str, Field(min_length=1, max_length=240)]] = Field(
        min_length=1, max_length=3
    )
    distinctions: list[Annotated[str, Field(min_length=1, max_length=240)]] = Field(
        min_length=2, max_length=3
    )


class DesignDirectionsPayload(BaseModel):
    source_geometry_policy: Literal["preserve_source_geometry"] = "preserve_source_geometry"
    cards: list[DesignDirectionCard] = Field(min_length=3, max_length=3)
    selected_direction_id: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def validate_direction_set(self):
        direction_ids = [card.direction_id for card in self.cards]
        if len(set(direction_ids)) != 3:
            raise ValueError("三张方向卡必须使用互不重复的 direction_id")
        strategy_signatures = {
            "|".join(sorted(item.lower() for item in card.spatial_strategies))
            for card in self.cards
        }
        if len(strategy_signatures) != 3:
            raise ValueError("三张方向卡的空间策略必须明确不同")
        if self.selected_direction_id and self.selected_direction_id not in direction_ids:
            raise ValueError("selected_direction_id 必须引用现有方向卡")
        return self


class DesignDirectionsVersionCreate(BaseModel):
    payload: DesignDirectionsPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class DesignConstraintItem(BaseModel):
    constraint_id: Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")]
    text: Annotated[str, Field(min_length=1, max_length=500)]
    source_kind: ConstraintSourceKind
    source_ref: Annotated[str, Field(min_length=1, max_length=200)]
    strength: ConstraintStrength
    designer_edited: bool = False


class DesignConstraintModule(BaseModel):
    module_id: ConstraintModuleKey
    title: Annotated[str, Field(min_length=1, max_length=80)]
    summary: Annotated[str, Field(min_length=1, max_length=300)]
    items: list[DesignConstraintItem] = Field(min_length=1, max_length=12)


class DesignConstraintConflict(BaseModel):
    conflict_id: Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")]
    text: Annotated[str, Field(min_length=1, max_length=500)]
    related_constraint_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        min_length=1, max_length=8
    )
    status: ConstraintConflictStatus = "unresolved"
    resolution: Annotated[str | None, Field(max_length=500)] = None

    @model_validator(mode="after")
    def require_resolution_when_resolved(self):
        if self.status == "resolved" and not (self.resolution or "").strip():
            raise ValueError("已解决的冲突必须填写处理方式")
        return self


class DesignSystemPayload(BaseModel):
    schema_version: Literal["home_v1"] = "home_v1"
    language: Annotated[str, Field(min_length=2, max_length=40)]
    source_geometry_policy: Literal["preserve_source_geometry"] = "preserve_source_geometry"
    modules: list[DesignConstraintModule] = Field(min_length=8, max_length=8)
    prohibited_items: list[DesignConstraintItem] = Field(min_length=1, max_length=12)
    conflicts: list[DesignConstraintConflict] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def validate_modules(self):
        expected = {
            "geometry_boundaries",
            "spatial_organization",
            "circulation_relationships",
            "function_storage",
            "materials_colors",
            "furniture_lighting",
            "budget_implementation",
            "open_questions",
        }
        module_ids = [module.module_id for module in self.modules]
        if set(module_ids) != expected or len(module_ids) != len(set(module_ids)):
            raise ValueError("方案约束包必须包含八个互不重复的家装模块")
        constraint_ids = [
            item.constraint_id
            for module in self.modules
            for item in module.items
        ] + [item.constraint_id for item in self.prohibited_items]
        if len(constraint_ids) != len(set(constraint_ids)):
            raise ValueError("方案约束条目 ID 必须互不重复")
        return self


class DesignSystemVersionCreate(BaseModel):
    payload: DesignSystemPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class DesignSystemModuleCandidatePayload(BaseModel):
    module_id: ConstraintModuleKey
    module: DesignConstraintModule

    @model_validator(mode="after")
    def validate_module_id(self):
        if self.module.module_id != self.module_id:
            raise ValueError("候选模块 ID 必须与请求模块一致")
        return self


SpaceRelationKind = Literal[
    "adjacent",
    "circulation",
    "visual_connection",
    "service",
    "material_continuity",
    "separation",
]
AssetRole = Literal["reference_image", "existing_render", "material_reference"]
AssetAdoptionStatus = Literal["candidate", "adopted"]


class NormalizedPoint(BaseModel):
    x: Annotated[float, Field(ge=0, le=1)]
    y: Annotated[float, Field(ge=0, le=1)]


class SpaceRegion(BaseModel):
    space_id: Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")]
    name: Annotated[str, Field(min_length=1, max_length=100)]
    use: Annotated[str, Field(min_length=1, max_length=300)]
    polygon: list[NormalizedPoint] = Field(min_length=3, max_length=80)
    is_key_space: bool = False
    designer_confirmed: bool = False

    @model_validator(mode="after")
    def reject_degenerate_polygon(self):
        twice_area = sum(
            point.x * self.polygon[(index + 1) % len(self.polygon)].y
            - self.polygon[(index + 1) % len(self.polygon)].x * point.y
            for index, point in enumerate(self.polygon)
        )
        if abs(twice_area) < 0.0001:
            raise ValueError("空间多边形面积不能为零")
        return self


class SpaceRelation(BaseModel):
    relation_id: Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")]
    from_space_id: Annotated[str, Field(min_length=1, max_length=80)]
    to_space_id: Annotated[str, Field(min_length=1, max_length=80)]
    relation_type: SpaceRelationKind
    note: Annotated[str, Field(min_length=1, max_length=500)]


class UpstreamVersionRefs(BaseModel):
    design_direction_artifact_id: uuid.UUID
    design_direction_version_id: uuid.UUID
    design_system_artifact_id: uuid.UUID
    design_system_version_id: uuid.UUID


class SpaceMapPayload(BaseModel):
    schema_version: Literal["home_v1"] = "home_v1"
    source_file_id: uuid.UUID
    page_index: Annotated[int, Field(ge=0, le=999)] = 0
    upstream: UpstreamVersionRefs
    spaces: list[SpaceRegion] = Field(min_length=1, max_length=60)
    relationships: list[SpaceRelation] = Field(default_factory=list, max_length=160)

    @model_validator(mode="after")
    def validate_space_graph(self):
        space_ids = [space.space_id for space in self.spaces]
        if len(space_ids) != len(set(space_ids)):
            raise ValueError("空间 ID 必须互不重复")
        relation_ids = [relation.relation_id for relation in self.relationships]
        if len(relation_ids) != len(set(relation_ids)):
            raise ValueError("空间关系 ID 必须互不重复")
        known_space_ids = set(space_ids)
        for relation in self.relationships:
            if relation.from_space_id == relation.to_space_id:
                raise ValueError("空间关系不能连接同一空间")
            if relation.from_space_id not in known_space_ids or relation.to_space_id not in known_space_ids:
                raise ValueError("空间关系必须引用当前图纸页面中的空间")
        return self


class SpaceMapCreate(BaseModel):
    payload: SpaceMapPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"

    @model_validator(mode="after")
    def confirmed_maps_require_confirmed_regions(self):
        if self.status == "confirmed" and any(not space.designer_confirmed for space in self.payload.spaces):
            raise ValueError("确认空间地图前必须确认全部空间区域")
        return self


class SpaceMapVersionCreate(SpaceMapCreate):
    pass


class ProposalCanvasPayload(BaseModel):
    schema_version: Literal["home_v1"] = "home_v1"
    title: Annotated[str, Field(min_length=1, max_length=160)]
    branch_id: Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")] = "main"
    space_map_artifact_id: uuid.UUID
    space_map_version_id: uuid.UUID
    upstream: UpstreamVersionRefs
    key_space_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def validate_key_spaces(self):
        if len(self.key_space_ids) != len(set(self.key_space_ids)):
            raise ValueError("关键空间不能重复")
        return self


class ProposalCanvasCreate(BaseModel):
    payload: ProposalCanvasPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None


class SpaceProposalPayload(BaseModel):
    schema_version: Literal["home_v1"] = "home_v1"
    proposal_canvas_artifact_id: uuid.UUID
    proposal_canvas_version_id: uuid.UUID
    space_map_artifact_id: uuid.UUID
    space_map_version_id: uuid.UUID
    space_id: Annotated[str, Field(min_length=1, max_length=80)]
    title: Annotated[str, Field(min_length=1, max_length=120)]
    objective: Annotated[str, Field(min_length=1, max_length=1200)]
    usage_scenario: Annotated[str, Field(min_length=1, max_length=1200)]
    spatial_strategy: Annotated[str, Field(min_length=1, max_length=1600)]
    image_focus: Annotated[str, Field(min_length=1, max_length=1000)]
    suggested_views: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(min_length=1, max_length=6)
    materials_and_furniture: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=12)
    lighting_language: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=8)
    inherited_constraint_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=80)
    prohibited_content: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=20)
    review_status: Literal["current", "needs_review"] = "current"


class SpaceProposalCreate(BaseModel):
    payload: SpaceProposalPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class SpaceProposalVersionCreate(SpaceProposalCreate):
    pass


class AssetManifestPayload(BaseModel):
    schema_version: Literal["home_v1"] = "home_v1"
    proposal_canvas_artifact_id: uuid.UUID
    proposal_canvas_version_id: uuid.UUID
    space_proposal_artifact_id: uuid.UUID
    space_proposal_version_id: uuid.UUID
    space_id: Annotated[str, Field(min_length=1, max_length=80)]
    source_file_id: uuid.UUID
    role: AssetRole
    adoption_status: AssetAdoptionStatus = "candidate"
    designer_edited: bool = False


class AssetManifestCreate(BaseModel):
    payload: AssetManifestPayload
    change_reason: Annotated[str | None, Field(max_length=1000)] = None
    status: ArtifactStatus = "draft"


class CanvasViewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: Annotated[float, Field(ge=0.1, le=4)] = 1


class CanvasLayoutNode(BaseModel):
    layout_node_id: Annotated[str, Field(min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9_-]+$")]
    artifact_id: uuid.UUID
    node_type: Literal["space_proposal", "asset_manifest"]
    x: float
    y: float
    width: Annotated[float, Field(ge=160, le=2000)]
    height: Annotated[float, Field(ge=100, le=2000)]
    z_index: Annotated[int, Field(ge=0, le=999)] = 0


class CanvasLayoutUpsert(BaseModel):
    viewport: CanvasViewport
    nodes: list[CanvasLayoutNode] = Field(default_factory=list, max_length=200)
    visible_layers: list[Literal["floor_plan", "spaces", "relationships", "assets"]] = Field(
        default_factory=lambda: ["floor_plan", "spaces", "relationships", "assets"]
    )
    narrative_order: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=60)

    @model_validator(mode="after")
    def validate_unique_layout_nodes(self):
        layout_node_ids = [node.layout_node_id for node in self.nodes]
        if len(layout_node_ids) != len(set(layout_node_ids)):
            raise ValueError("画布布局节点 ID 必须互不重复")
        return self


class CanvasLayoutRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    proposal_canvas_id: uuid.UUID
    payload: CanvasLayoutUpsert
    created_at: datetime
    updated_at: datetime


class ProjectUnderstandingTaskCreate(BaseModel):
    brief_artifact_id: uuid.UUID


class DesignDirectionsTaskCreate(BaseModel):
    project_understanding_artifact_id: uuid.UUID


class DesignSystemTaskCreate(BaseModel):
    design_direction_artifact_id: uuid.UUID


class DesignSystemModuleTaskCreate(BaseModel):
    design_system_artifact_id: uuid.UUID
    module_id: ConstraintModuleKey


class AiTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    task_type: str
    status: AiTaskStatus
    input_artifact_version_id: uuid.UUID
    output_artifact_id: uuid.UUID | None
    provider: str
    model: str
    attempt_count: int
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class ArtifactVersionRead(BaseModel):
    id: uuid.UUID
    version: int
    status: ArtifactStatus
    payload: dict
    input_refs: list[dict]
    created_by_id: uuid.UUID
    change_reason: str | None
    content_hash: str
    created_at: datetime


class ArtifactRead(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    artifact_type: str
    current_version_id: uuid.UUID | None
    created_at: datetime
    current_version: ArtifactVersionRead | None


class StoredFileRead(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    original_filename: str
    media_type: str
    size_bytes: int
    content_hash: str
    created_at: datetime
