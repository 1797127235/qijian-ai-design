import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import AiTask, Artifact, ArtifactVersion, CanvasLayout, Project, StoredFile
from app.schemas import (
    AiTaskRead,
    ArtifactCreate,
    ArtifactRead,
    ArtifactVersionCreate,
    ArtifactVersionRead,
    AssetManifestCreate,
    CanvasLayoutRead,
    CanvasLayoutUpsert,
    DesignDirectionsTaskCreate,
    DesignDirectionsVersionCreate,
    DesignSystemTaskCreate,
    DesignSystemModuleTaskCreate,
    DesignSystemVersionCreate,
    ProjectCreate,
    ProjectUnderstandingTaskCreate,
    ProjectUnderstandingVersionCreate,
    ProjectRead,
    ProposalCanvasCreate,
    ProposalCanvasPayload,
    SpaceMapCreate,
    SpaceMapPayload,
    SpaceMapVersionCreate,
    SpaceProposalCreate,
    SpaceProposalPayload,
    SpaceProposalVersionCreate,
    StoredFileRead,
)
from app.services import (
    append_payload_version,
    append_version,
    artifact_version_or_422,
    get_development_designer,
    owned_artifact_or_404,
    owned_file_or_404,
    owned_project_or_404,
)
from app.storage import LocalStorage


app = FastAPI(title="Qijian AI Design API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
storage = LocalStorage(settings.upload_dir)


def next_artifact_version_number(db: Session, artifact: Artifact) -> int:
    latest = db.scalar(
        select(ArtifactVersion.version)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version.desc())
        .limit(1)
    )
    return (latest or 0) + 1


def append_typed_payload(
    db: Session,
    artifact: Artifact,
    owner,
    payload: dict,
    *,
    status_value: str,
    change_reason: str | None,
    input_refs: list[dict] | None = None,
) -> None:
    append_payload_version(
        db,
        artifact=artifact,
        owner=owner,
        payload=payload,
        input_refs=input_refs or [],
        change_reason=change_reason,
        status=status_value,
        version_number=next_artifact_version_number(db, artifact),
    )


def validate_upstream_refs(db: Session, project_id: uuid.UUID, upstream) -> None:
    artifact_version_or_422(
        db,
        artifact_id=upstream.design_direction_artifact_id,
        version_id=upstream.design_direction_version_id,
        project_id=project_id,
        artifact_type="design_directions",
        required_status="confirmed",
    )
    artifact_version_or_422(
        db,
        artifact_id=upstream.design_system_artifact_id,
        version_id=upstream.design_system_version_id,
        project_id=project_id,
        artifact_type="design_system",
        required_status="confirmed",
    )


def validate_space_map_payload(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, payload: SpaceMapPayload) -> None:
    source_file = owned_file_or_404(db, payload.source_file_id, owner_id)
    if source_file.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="空间地图必须引用当前项目的户型资料")
    if source_file.media_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="第一版空间地图仅支持 PNG 或 JPG 户型图")
    validate_upstream_refs(db, project_id, payload.upstream)


def space_map_version_for_payload(db: Session, project_id: uuid.UUID, payload: ProposalCanvasPayload) -> SpaceMapPayload:
    version = artifact_version_or_422(
        db,
        artifact_id=payload.space_map_artifact_id,
        version_id=payload.space_map_version_id,
        project_id=project_id,
        artifact_type="space_map",
        required_status="confirmed",
    )
    space_map = SpaceMapPayload.model_validate(version.payload)
    known_spaces = {space.space_id: space for space in space_map.spaces}
    if any(space_id not in known_spaces for space_id in payload.key_space_ids):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="提案画布包含不存在的关键空间")
    if any(not known_spaces[space_id].is_key_space for space_id in payload.key_space_ids):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="提案画布只能选择空间地图中标记的关键空间")
    return space_map


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)) -> Project:
    owner = get_development_designer(db)
    project = Project(owner_id=owner.id, **body.model_dump())
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@app.get("/api/v1/projects", response_model=list[ProjectRead])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    owner = get_development_designer(db)
    return list(db.scalars(select(Project).where(Project.owner_id == owner.id).order_by(Project.updated_at.desc())))


@app.get("/api/v1/projects/{project_id}", response_model=ProjectRead)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db)) -> Project:
    owner = get_development_designer(db)
    return owned_project_or_404(db, project_id, owner.id)


@app.delete("/api/v1/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db)) -> None:
    owner = get_development_designer(db)
    project = owned_project_or_404(db, project_id, owner.id)
    files = list(db.scalars(select(StoredFile).where(StoredFile.project_id == project.id)))
    artifacts = list(db.scalars(select(Artifact).where(Artifact.project_id == project.id)))
    artifact_ids = [artifact.id for artifact in artifacts]

    # Delete dependent rows explicitly because task foreign keys point into artifact history.
    db.execute(delete(AiTask).where(AiTask.project_id == project.id))
    db.execute(delete(CanvasLayout).where(CanvasLayout.project_id == project.id))
    if artifact_ids:
        db.execute(delete(ArtifactVersion).where(ArtifactVersion.artifact_id.in_(artifact_ids)))
        db.execute(delete(Artifact).where(Artifact.id.in_(artifact_ids)))
    db.execute(delete(StoredFile).where(StoredFile.project_id == project.id))
    db.delete(project)
    db.commit()
    for stored_file in files:
        storage.delete(stored_file.object_key)


@app.post(
    "/api/v1/projects/{project_id}/artifacts",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_artifact(
    project_id: uuid.UUID, body: ArtifactCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    artifact = Artifact(project_id=project_id, artifact_type=body.artifact_type)
    db.add(artifact)
    db.flush()
    append_version(db, artifact, owner, body, version_number=1)
    db.commit()
    db.refresh(artifact)
    return artifact


@app.get("/api/v1/projects/{project_id}/artifacts", response_model=list[ArtifactRead])
def list_project_artifacts(project_id: uuid.UUID, db: Session = Depends(get_db)) -> list[Artifact]:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    return list(
        db.scalars(
            select(Artifact).where(Artifact.project_id == project_id).order_by(Artifact.created_at.desc())
        )
    )


@app.get("/api/v1/projects/{project_id}/files", response_model=list[StoredFileRead])
def list_project_files(project_id: uuid.UUID, db: Session = Depends(get_db)) -> list[StoredFile]:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    return list(
        db.scalars(
            select(StoredFile)
            .where(StoredFile.project_id == project_id)
            .order_by(StoredFile.created_at.desc())
        )
    )


@app.get("/api/v1/files/{file_id}/content")
def get_file_content(file_id: uuid.UUID, db: Session = Depends(get_db)) -> FileResponse:
    owner = get_development_designer(db)
    stored_file = owned_file_or_404(db, file_id, owner.id)
    path = settings.upload_dir / stored_file.object_key
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件内容不存在")
    return FileResponse(path, media_type=stored_file.media_type, filename=stored_file.original_filename)


@app.get("/api/v1/artifacts/{artifact_id}", response_model=ArtifactRead)
def get_artifact(artifact_id: uuid.UUID, db: Session = Depends(get_db)) -> Artifact:
    owner = get_development_designer(db)
    return owned_artifact_or_404(db, artifact_id, owner.id)


@app.get("/api/v1/artifacts/{artifact_id}/versions", response_model=list[ArtifactVersionRead])
def list_artifact_versions(artifact_id: uuid.UUID, db: Session = Depends(get_db)) -> list[ArtifactVersion]:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    return list(
        db.scalars(
            select(ArtifactVersion)
            .where(ArtifactVersion.artifact_id == artifact.id)
            .order_by(ArtifactVersion.version.desc())
        )
    )


@app.post(
    "/api/v1/artifacts/{artifact_id}/versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_artifact_version(
    artifact_id: uuid.UUID, body: ArtifactVersionCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    latest_version = db.scalar(
        select(ArtifactVersion.version)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version.desc())
        .limit(1)
    )
    append_version(db, artifact, owner, body, version_number=(latest_version or 0) + 1)
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/projects/{project_id}/space-maps",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_space_map(project_id: uuid.UUID, body: SpaceMapCreate, db: Session = Depends(get_db)) -> Artifact:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    validate_space_map_payload(db, project_id, owner.id, body.payload)
    artifact = Artifact(project_id=project_id, artifact_type="space_map")
    db.add(artifact)
    db.flush()
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value=body.status,
        change_reason=body.change_reason or "创建空间地图草稿",
        input_refs=[{"file_id": str(body.payload.source_file_id), "role": "floor_plan"}],
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/artifacts/{artifact_id}/space-map-versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_space_map_version(
    artifact_id: uuid.UUID, body: SpaceMapVersionCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    if artifact.artifact_type != "space_map":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是空间地图")
    validate_space_map_payload(db, artifact.project_id, owner.id, body.payload)
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value=body.status,
        change_reason=body.change_reason or ("确认空间地图" if body.status == "confirmed" else "保存空间地图草稿"),
        input_refs=[{"file_id": str(body.payload.source_file_id), "role": "floor_plan"}],
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/projects/{project_id}/proposal-canvases",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_proposal_canvas(
    project_id: uuid.UUID, body: ProposalCanvasCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    validate_upstream_refs(db, project_id, body.payload.upstream)
    space_map = space_map_version_for_payload(db, project_id, body.payload)
    if space_map.upstream != body.payload.upstream:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="提案画布必须沿用空间地图绑定的方向与约束版本")
    artifact = Artifact(project_id=project_id, artifact_type="proposal_canvas")
    db.add(artifact)
    db.flush()
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value="draft",
        change_reason=body.change_reason or "创建结构化提案画布",
    )
    db.commit()
    db.refresh(artifact)
    return artifact


def validate_space_proposal_payload(
    db: Session, project_id: uuid.UUID, payload: SpaceProposalPayload
) -> ProposalCanvasPayload:
    canvas_version = artifact_version_or_422(
        db,
        artifact_id=payload.proposal_canvas_artifact_id,
        version_id=payload.proposal_canvas_version_id,
        project_id=project_id,
        artifact_type="proposal_canvas",
    )
    canvas = ProposalCanvasPayload.model_validate(canvas_version.payload)
    if (
        payload.space_map_artifact_id != canvas.space_map_artifact_id
        or payload.space_map_version_id != canvas.space_map_version_id
    ):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="空间提案必须沿用提案画布绑定的空间地图版本")
    if payload.space_id not in canvas.key_space_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="空间提案只能创建在画布选定的关键空间中")
    return canvas


@app.post(
    "/api/v1/projects/{project_id}/space-proposals",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_space_proposal(
    project_id: uuid.UUID, body: SpaceProposalCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    validate_space_proposal_payload(db, project_id, body.payload)
    artifact = Artifact(project_id=project_id, artifact_type="space_proposal")
    db.add(artifact)
    db.flush()
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value=body.status,
        change_reason=body.change_reason or "创建空间提案卡",
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/artifacts/{artifact_id}/space-proposal-versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_space_proposal_version(
    artifact_id: uuid.UUID, body: SpaceProposalVersionCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    if artifact.artifact_type != "space_proposal":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是空间提案")
    validate_space_proposal_payload(db, artifact.project_id, body.payload)
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value=body.status,
        change_reason=body.change_reason or "保存空间提案",
    )
    db.commit()
    db.refresh(artifact)
    return artifact


def validate_asset_manifest_payload(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, payload) -> None:
    proposal_version = artifact_version_or_422(
        db,
        artifact_id=payload.space_proposal_artifact_id,
        version_id=payload.space_proposal_version_id,
        project_id=project_id,
        artifact_type="space_proposal",
    )
    proposal = SpaceProposalPayload.model_validate(proposal_version.payload)
    if (
        proposal.proposal_canvas_artifact_id != payload.proposal_canvas_artifact_id
        or proposal.proposal_canvas_version_id != payload.proposal_canvas_version_id
        or proposal.space_id != payload.space_id
    ):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="资产必须绑定到一致的空间提案和画布版本")
    source_file = owned_file_or_404(db, payload.source_file_id, owner_id)
    if source_file.project_id != project_id or source_file.media_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="第一版仅能挂载当前项目中的 PNG 或 JPG 资产")


@app.post(
    "/api/v1/projects/{project_id}/asset-manifests",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_asset_manifest(
    project_id: uuid.UUID, body: AssetManifestCreate, db: Session = Depends(get_db)
) -> Artifact:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    validate_asset_manifest_payload(db, project_id, owner.id, body.payload)
    artifact = Artifact(project_id=project_id, artifact_type="asset_manifest")
    db.add(artifact)
    db.flush()
    append_typed_payload(
        db,
        artifact,
        owner,
        body.payload.model_dump(mode="json"),
        status_value=body.status,
        change_reason=body.change_reason or "挂载空间提案资产",
        input_refs=[{"file_id": str(body.payload.source_file_id), "role": "reference_image"}],
    )
    db.commit()
    db.refresh(artifact)
    return artifact


def validate_canvas_layout_nodes(
    db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, body: CanvasLayoutUpsert
) -> None:
    for node in body.nodes:
        artifact = owned_artifact_or_404(db, node.artifact_id, owner_id)
        expected_type = "space_proposal" if node.node_type == "space_proposal" else "asset_manifest"
        if artifact.project_id != project_id or artifact.artifact_type != expected_type:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="画布布局不能引用其他项目或错误类型的节点")


@app.get(
    "/api/v1/proposal-canvases/{proposal_canvas_id}/layout",
    response_model=CanvasLayoutRead | None,
)
def get_canvas_layout(proposal_canvas_id: uuid.UUID, db: Session = Depends(get_db)) -> CanvasLayout | None:
    owner = get_development_designer(db)
    canvas = owned_artifact_or_404(db, proposal_canvas_id, owner.id)
    if canvas.artifact_type != "proposal_canvas":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是提案画布")
    return db.scalar(select(CanvasLayout).where(CanvasLayout.proposal_canvas_id == canvas.id))


@app.put(
    "/api/v1/proposal-canvases/{proposal_canvas_id}/layout",
    response_model=CanvasLayoutRead,
)
def upsert_canvas_layout(
    proposal_canvas_id: uuid.UUID, body: CanvasLayoutUpsert, db: Session = Depends(get_db)
) -> CanvasLayout:
    owner = get_development_designer(db)
    canvas = owned_artifact_or_404(db, proposal_canvas_id, owner.id)
    if canvas.artifact_type != "proposal_canvas":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是提案画布")
    validate_canvas_layout_nodes(db, canvas.project_id, owner.id, body)
    layout = db.scalar(select(CanvasLayout).where(CanvasLayout.proposal_canvas_id == canvas.id))
    if layout is None:
        layout = CanvasLayout(
            project_id=canvas.project_id,
            proposal_canvas_id=canvas.id,
            payload=body.model_dump(mode="json"),
            updated_by_id=owner.id,
        )
        db.add(layout)
    else:
        layout.payload = body.model_dump(mode="json")
        layout.updated_by_id = owner.id
    db.commit()
    db.refresh(layout)
    return layout


@app.post(
    "/api/v1/projects/{project_id}/project-understanding-tasks",
    response_model=AiTaskRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project_understanding_task(
    project_id: uuid.UUID,
    body: ProjectUnderstandingTaskCreate,
    db: Session = Depends(get_db),
) -> AiTask:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    brief = owned_artifact_or_404(db, body.brief_artifact_id, owner.id)
    if brief.project_id != project_id or brief.artifact_type != "design_brief":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择该项目的设计 Brief")
    if brief.current_version_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="设计 Brief 没有可用版本")
    if brief.current_version is None or not any(
        item.get("role") == "floor_plan" for item in brief.current_version.input_refs
    ):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先上传并关联一张户型图或图纸 PDF")

    task = AiTask(
        project_id=project_id,
        task_type="project_understanding",
        status="pending",
        input_artifact_version_id=brief.current_version_id,
        provider="codex2api",
        model=settings.ai_model,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.post(
    "/api/v1/projects/{project_id}/design-directions-tasks",
    response_model=AiTaskRead,
    status_code=status.HTTP_201_CREATED,
)
def create_design_directions_task(
    project_id: uuid.UUID,
    body: DesignDirectionsTaskCreate,
    db: Session = Depends(get_db),
) -> AiTask:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    understanding = owned_artifact_or_404(db, body.project_understanding_artifact_id, owner.id)
    if understanding.project_id != project_id or understanding.artifact_type != "project_understanding":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择该项目的项目理解卡")
    if understanding.current_version is None or understanding.current_version.status != "confirmed":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先确认项目理解卡")
    if not any(item.get("role") == "floor_plan" for item in understanding.current_version.input_refs):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="项目理解卡没有关联原始户型图")

    task = AiTask(
        project_id=project_id,
        task_type="design_directions",
        status="pending",
        input_artifact_version_id=understanding.current_version.id,
        provider="codex2api",
        model=settings.ai_model,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.post(
    "/api/v1/projects/{project_id}/design-system-tasks",
    response_model=AiTaskRead,
    status_code=status.HTTP_201_CREATED,
)
def create_design_system_task(
    project_id: uuid.UUID,
    body: DesignSystemTaskCreate,
    db: Session = Depends(get_db),
) -> AiTask:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    directions = owned_artifact_or_404(db, body.design_direction_artifact_id, owner.id)
    if directions.project_id != project_id or directions.artifact_type != "design_directions":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择该项目的设计方向集")
    if directions.current_version is None or directions.current_version.status != "confirmed":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先确认设计方向")
    if directions.current_version.payload.get("selected_direction_id") is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="确认方向时必须选择一张方向卡")

    task = AiTask(
        project_id=project_id,
        task_type="design_system",
        status="pending",
        input_artifact_version_id=directions.current_version.id,
        provider="codex2api",
        model=settings.ai_model,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.post(
    "/api/v1/projects/{project_id}/design-system-module-tasks",
    response_model=AiTaskRead,
    status_code=status.HTTP_201_CREATED,
)
def create_design_system_module_task(
    project_id: uuid.UUID,
    body: DesignSystemModuleTaskCreate,
    db: Session = Depends(get_db),
) -> AiTask:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    design_system = owned_artifact_or_404(db, body.design_system_artifact_id, owner.id)
    if design_system.project_id != project_id or design_system.artifact_type != "design_system":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择该项目的方案约束包")
    if design_system.current_version is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="方案约束包没有可用版本")
    if design_system.current_version.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="已确认的方案约束包不能直接重新生成模块")

    task = AiTask(
        project_id=project_id,
        task_type=f"design_system_module:{body.module_id}",
        status="pending",
        input_artifact_version_id=design_system.current_version.id,
        provider="codex2api",
        model=settings.ai_model,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.get("/api/v1/ai-tasks/{task_id}", response_model=AiTaskRead)
def get_ai_task(task_id: uuid.UUID, db: Session = Depends(get_db)) -> AiTask:
    owner = get_development_designer(db)
    task = db.scalar(select(AiTask).join(Project).where(AiTask.id == task_id, Project.owner_id == owner.id))
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该生成任务")
    return task


@app.post("/api/v1/ai-tasks/{task_id}/retry", response_model=AiTaskRead, status_code=status.HTTP_201_CREATED)
def retry_ai_task(task_id: uuid.UUID, db: Session = Depends(get_db)) -> AiTask:
    owner = get_development_designer(db)
    previous_task = db.scalar(
        select(AiTask).join(Project).where(AiTask.id == task_id, Project.owner_id == owner.id)
    )
    if previous_task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该生成任务")
    if previous_task.status != "failed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="只有失败的任务可以重试")

    task = AiTask(
        project_id=previous_task.project_id,
        task_type=previous_task.task_type,
        status="pending",
        input_artifact_version_id=previous_task.input_artifact_version_id,
        provider=previous_task.provider,
        model=previous_task.model,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.post(
    "/api/v1/artifacts/{artifact_id}/project-understanding-versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project_understanding_version(
    artifact_id: uuid.UUID,
    body: ProjectUnderstandingVersionCreate,
    db: Session = Depends(get_db),
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    if artifact.artifact_type != "project_understanding":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是项目理解卡")
    if artifact.current_version is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="项目理解卡没有可用版本")
    latest_version = db.scalar(
        select(ArtifactVersion.version)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version.desc())
        .limit(1)
    )
    append_payload_version(
        db,
        artifact=artifact,
        owner=owner,
        payload=body.payload.model_dump(mode="json"),
        input_refs=artifact.current_version.input_refs,
        change_reason=body.change_reason,
        status=body.status,
        version_number=(latest_version or 0) + 1,
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/artifacts/{artifact_id}/design-direction-versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_design_directions_version(
    artifact_id: uuid.UUID,
    body: DesignDirectionsVersionCreate,
    db: Session = Depends(get_db),
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    if artifact.artifact_type != "design_directions":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是设计方向集")
    if artifact.current_version is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="设计方向集没有可用版本")
    if body.status == "confirmed" and body.payload.selected_direction_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="确认方向时必须选择一张方向卡")
    latest_version = db.scalar(
        select(ArtifactVersion.version)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version.desc())
        .limit(1)
    )
    append_payload_version(
        db,
        artifact=artifact,
        owner=owner,
        payload=body.payload.model_dump(mode="json"),
        input_refs=artifact.current_version.input_refs,
        change_reason=body.change_reason,
        status=body.status,
        version_number=(latest_version or 0) + 1,
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/artifacts/{artifact_id}/design-system-versions",
    response_model=ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
def create_design_system_version(
    artifact_id: uuid.UUID,
    body: DesignSystemVersionCreate,
    db: Session = Depends(get_db),
) -> Artifact:
    owner = get_development_designer(db)
    artifact = owned_artifact_or_404(db, artifact_id, owner.id)
    if artifact.artifact_type != "design_system":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="该 Artifact 不是方案约束包")
    if artifact.current_version is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="方案约束包没有可用版本")
    if body.status == "confirmed":
        unresolved_items = [
            item
            for module in body.payload.modules
            for item in module.items
            if item.strength == "unresolved"
        ] + [item for item in body.payload.prohibited_items if item.strength == "unresolved"]
        unresolved_conflicts = [item for item in body.payload.conflicts if item.status == "unresolved"]
        if unresolved_items or unresolved_conflicts:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="确认方案约束前必须处理所有待确认约束和冲突",
            )
    latest_version = db.scalar(
        select(ArtifactVersion.version)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version.desc())
        .limit(1)
    )
    append_payload_version(
        db,
        artifact=artifact,
        owner=owner,
        payload=body.payload.model_dump(mode="json"),
        input_refs=artifact.current_version.input_refs,
        change_reason=body.change_reason,
        status=body.status,
        version_number=(latest_version or 0) + 1,
    )
    db.commit()
    db.refresh(artifact)
    return artifact


@app.post(
    "/api/v1/projects/{project_id}/files",
    response_model=StoredFileRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_file(
    project_id: uuid.UUID,
    upload: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> StoredFile:
    owner = get_development_designer(db)
    owned_project_or_404(db, project_id, owner.id)
    allowed_uploads = {
        "application/pdf": {".pdf"},
        "image/jpeg": {".jpg", ".jpeg"},
        "image/png": {".png"},
    }
    suffix = Path(upload.filename or "").suffix.lower()
    if upload.content_type not in allowed_uploads or suffix not in allowed_uploads[upload.content_type]:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="只支持 PDF、JPG 和 PNG")
    try:
        object_key, content_hash, size_bytes = await storage.save(project_id, upload, 20 * 1024 * 1024)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    stored_file = StoredFile(
        project_id=project_id,
        uploaded_by_id=owner.id,
        original_filename=upload.filename or "untitled",
        media_type=upload.content_type,
        size_bytes=size_bytes,
        content_hash=content_hash,
        object_key=object_key,
    )
    db.add(stored_file)
    db.commit()
    db.refresh(stored_file)
    return stored_file
