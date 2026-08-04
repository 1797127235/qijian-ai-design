import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Designer(Base):
    __tablename__ = "designers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("designers.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    project_type: Mapped[str] = mapped_column(String(40))
    area_sqm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    owner: Mapped[Designer] = relationship()
    artifacts: Mapped[list["Artifact"]] = relationship(back_populates="project")


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    artifact_type: Mapped[str] = mapped_column(String(80), index=True)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="artifacts")
    versions: Mapped[list["ArtifactVersion"]] = relationship(
        back_populates="artifact", order_by="ArtifactVersion.version", cascade="all, delete-orphan"
    )

    @property
    def current_version(self) -> "ArtifactVersion | None":
        return next((item for item in self.versions if item.id == self.current_version_id), None)


class ArtifactVersion(Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (UniqueConstraint("artifact_id", "version", name="uq_artifact_version_number"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifacts.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    payload: Mapped[dict] = mapped_column(JSONB)
    input_refs: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("designers.id"))
    change_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    artifact: Mapped[Artifact] = relationship(back_populates="versions")
    created_by: Mapped[Designer] = relationship()


class CanvasLayout(Base):
    __tablename__ = "canvas_layouts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    proposal_canvas_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("artifacts.id"), unique=True, index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB)
    updated_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("designers.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship()
    proposal_canvas: Mapped[Artifact] = relationship()
    updated_by: Mapped[Designer] = relationship()


class StoredFile(Base):
    __tablename__ = "stored_files"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    uploaded_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("designers.id"))
    original_filename: Mapped[str] = mapped_column(String(500))
    media_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    object_key: Mapped[str] = mapped_column(String(500), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AiTask(Base):
    __tablename__ = "ai_tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    task_type: Mapped[str] = mapped_column(String(80), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True, default="pending")
    input_artifact_version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id"))
    output_artifact_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("artifacts.id"), nullable=True)
    provider: Mapped[str] = mapped_column(String(80), default="codex2api")
    model: Mapped[str] = mapped_column(String(120))
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship()
    input_artifact_version: Mapped[ArtifactVersion] = relationship(foreign_keys=[input_artifact_version_id])
    output_artifact: Mapped[Artifact | None] = relationship(foreign_keys=[output_artifact_id])
