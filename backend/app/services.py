import hashlib
import json
import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Artifact, ArtifactVersion, Designer, Project, StoredFile
from app.schemas import ArtifactCreate, ArtifactVersionCreate


def get_development_designer(db: Session) -> Designer:
    designer = db.scalar(
        select(Designer).where(Designer.email == settings.development_designer_email)
    )
    if designer is None:
        designer = Designer(email=settings.development_designer_email, display_name="开发设计师")
        db.add(designer)
        db.flush()
    return designer


def owned_project_or_404(db: Session, project_id: uuid.UUID, designer_id: uuid.UUID) -> Project:
    project = db.scalar(
        select(Project).where(Project.id == project_id, Project.owner_id == designer_id)
    )
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该设计项目")
    return project


def owned_artifact_or_404(db: Session, artifact_id: uuid.UUID, designer_id: uuid.UUID) -> Artifact:
    artifact = db.scalar(
        select(Artifact)
        .join(Project)
        .where(Artifact.id == artifact_id, Project.owner_id == designer_id)
    )
    if artifact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该 Artifact")
    return artifact


def owned_file_or_404(db: Session, file_id: uuid.UUID, designer_id: uuid.UUID) -> StoredFile:
    stored_file = db.scalar(
        select(StoredFile)
        .join(Project, Project.id == StoredFile.project_id)
        .where(StoredFile.id == file_id, Project.owner_id == designer_id)
    )
    if stored_file is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件不存在或无权访问")
    return stored_file


def artifact_version_or_422(
    db: Session,
    *,
    artifact_id: uuid.UUID,
    version_id: uuid.UUID,
    project_id: uuid.UUID,
    artifact_type: str,
    required_status: str | None = None,
) -> ArtifactVersion:
    version = db.scalar(
        select(ArtifactVersion)
        .join(Artifact, Artifact.id == ArtifactVersion.artifact_id)
        .where(
            ArtifactVersion.id == version_id,
            Artifact.id == artifact_id,
            Artifact.project_id == project_id,
            Artifact.artifact_type == artifact_type,
        )
    )
    if version is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"{artifact_type} 版本不存在或不属于当前项目")
    if required_status and version.status != required_status:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"{artifact_type} 必须引用已确认版本")
    return version


def validate_file_refs(
    db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, input_refs: list[dict]
) -> None:
    if not input_refs:
        return
    file_ids = [ref["file_id"] for ref in input_refs]
    count = db.scalar(
        select(func.count())
        .where(
            StoredFile.id.in_(file_ids),
            StoredFile.project_id == project_id,
            StoredFile.uploaded_by_id == owner_id,
        )
    )
    if count != len(set(file_ids)):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="存在无权关联的文件")


def canonical_hash(payload: dict, input_refs: list[dict]) -> str:
    canonical = json.dumps(
        {"payload": payload, "input_refs": input_refs}, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def append_version(
    db: Session,
    artifact: Artifact,
    owner: Designer,
    body: ArtifactCreate | ArtifactVersionCreate,
    version_number: int,
) -> ArtifactVersion:
    input_refs = [item.model_dump(mode="json") for item in body.input_refs]
    payload = body.payload.model_dump(mode="json")
    return append_payload_version(
        db,
        artifact=artifact,
        owner=owner,
        payload=payload,
        input_refs=input_refs,
        change_reason=body.change_reason,
        status=getattr(body, "status", "draft"),
        version_number=version_number,
    )


def append_payload_version(
    db: Session,
    artifact: Artifact,
    owner: Designer,
    payload: dict,
    input_refs: list[dict],
    change_reason: str | None,
    status: str,
    version_number: int,
) -> ArtifactVersion:
    validate_file_refs(db, artifact.project_id, owner.id, input_refs)
    artifact_version = ArtifactVersion(
        artifact_id=artifact.id,
        version=version_number,
        status=status,
        payload=payload,
        input_refs=input_refs,
        created_by_id=owner.id,
        change_reason=change_reason,
        content_hash=canonical_hash(payload, input_refs),
    )
    db.add(artifact_version)
    db.flush()
    artifact.current_version_id = artifact_version.id
    return artifact_version
