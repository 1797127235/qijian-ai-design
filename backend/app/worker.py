import logging
import time
from datetime import datetime, timezone
import uuid

import fitz
from sqlalchemy import or_, select

from app.database import SessionLocal
from app.grok import AiGatewayError, GrokVisionClient, ImageInput
from app.models import AiTask, Artifact, ArtifactVersion, StoredFile
from app.schemas import DesignSystemModuleCandidatePayload, DesignSystemPayload
from app.services import append_payload_version, get_development_designer
from app.storage import LocalStorage
from app.config import settings


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
storage = LocalStorage(settings.upload_dir)


def claim_next_task() -> uuid.UUID | None:
    with SessionLocal.begin() as db:
        task = db.scalar(
            select(AiTask)
            .where(
                AiTask.status == "pending",
                or_(
                    AiTask.task_type.in_(["project_understanding", "design_directions", "design_system"]),
                    AiTask.task_type.like("design_system_module:%"),
                ),
            )
            .order_by(AiTask.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if task is None:
            return None
        task.status = "running"
        task.attempt_count += 1
        task.started_at = datetime.now(timezone.utc)
        task.error_message = None
        return task.id


def image_inputs_for_version(
    db, version: ArtifactVersion, roles: set[str] | None = None
) -> list[ImageInput]:
    allowed_roles = roles or {"floor_plan"}
    file_ids = [item["file_id"] for item in version.input_refs if item.get("role") in allowed_roles]
    if not file_ids:
        return []
    files = list(db.scalars(select(StoredFile).where(StoredFile.id.in_(file_ids))))
    images: list[ImageInput] = []
    for stored_file in files:
        content = storage.read_bytes(stored_file.object_key)
        if stored_file.media_type in {"image/jpeg", "image/png"}:
            images.append(ImageInput(media_type=stored_file.media_type, content=content))
        elif stored_file.media_type == "application/pdf":
            document = fitz.open(stream=content, filetype="pdf")
            for page in document[:2]:
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                images.append(ImageInput(media_type="image/png", content=pixmap.tobytes("png")))
    return images


def run_task(task_id: uuid.UUID) -> None:
    with SessionLocal() as db:
        task = db.get(AiTask, task_id)
        if task is None:
            return
        try:
            input_version = db.get(ArtifactVersion, task.input_artifact_version_id)
            if input_version is None:
                raise AiGatewayError("项目 Brief 版本不存在")
            client = GrokVisionClient()
            if task.task_type == "project_understanding":
                result = client.generate_project_understanding(
                    input_version.payload, image_inputs_for_version(db, input_version)
                )
                artifact_type = "project_understanding"
                change_reason = "根据已确认 Brief 生成项目理解草稿"
            elif task.task_type == "design_directions":
                result = client.generate_design_directions(
                    input_version.payload,
                    image_inputs_for_version(db, input_version, {"floor_plan", "reference_image"}),
                )
                artifact_type = "design_directions"
                change_reason = "根据已确认项目理解生成设计方向草稿"
            elif task.task_type == "design_system":
                brief = db.scalar(
                    select(Artifact).where(
                        Artifact.project_id == task.project_id,
                        Artifact.artifact_type == "design_brief",
                    )
                )
                understanding = db.scalar(
                    select(Artifact).where(
                        Artifact.project_id == task.project_id,
                        Artifact.artifact_type == "project_understanding",
                    )
                )
                result = client.generate_design_system(
                    input_version.payload,
                    {
                        "brief": brief.current_version.payload if brief and brief.current_version else {},
                        "project_understanding": (
                            understanding.current_version.payload
                            if understanding and understanding.current_version
                            else {}
                        ),
                    },
                    image_inputs_for_version(db, input_version, {"floor_plan", "reference_image"}),
                )
                artifact_type = "design_system"
                change_reason = "根据已确认设计方向生成方案约束草稿"
            elif task.task_type.startswith("design_system_module:"):
                module_id = task.task_type.removeprefix("design_system_module:")
                module = client.generate_design_system_module(
                    input_version.payload,
                    module_id,
                    image_inputs_for_version(db, input_version, {"floor_plan", "reference_image"}),
                )
                # Check that applying the candidate would keep the whole package valid.
                DesignSystemPayload.model_validate({
                    **input_version.payload,
                    "modules": [
                        module.model_dump(mode="json") if item.get("module_id") == module_id else item
                        for item in input_version.payload.get("modules", [])
                    ],
                })
                result = DesignSystemModuleCandidatePayload(module_id=module_id, module=module)
                artifact_type = "design_system_module_candidate"
                change_reason = f"重新生成方案约束模块 {module_id} 的候选草稿"
            else:
                raise AiGatewayError(f"不支持的 AI 任务类型: {task.task_type}")
            owner = get_development_designer(db)
            artifact = Artifact(project_id=task.project_id, artifact_type=artifact_type)
            db.add(artifact)
            db.flush()
            append_payload_version(
                db,
                artifact=artifact,
                owner=owner,
                payload=result.model_dump(mode="json"),
                input_refs=input_version.input_refs,
                change_reason=change_reason,
                status="draft",
                version_number=1,
            )
            task.output_artifact_id = artifact.id
            task.status = "succeeded"
            task.completed_at = datetime.now(timezone.utc)
            db.commit()
            logger.info("Completed AI task %s", task_id)
        except (AiGatewayError, OSError, fitz.FileDataError) as error:
            db.rollback()
            failed_task = db.get(AiTask, task_id)
            if failed_task is not None:
                failed_task.status = "failed"
                failed_task.error_message = str(error)
                failed_task.completed_at = datetime.now(timezone.utc)
                db.commit()
            logger.warning("AI task %s failed: %s", task_id, error)
        except Exception:
            db.rollback()
            failed_task = db.get(AiTask, task_id)
            if failed_task is not None:
                failed_task.status = "failed"
                failed_task.error_message = "AI 生成时发生内部错误"
                failed_task.completed_at = datetime.now(timezone.utc)
                db.commit()
            logger.exception("AI task %s failed unexpectedly", task_id)


def main() -> None:
    logger.info("Qijian AI worker started")
    while True:
        task_id = claim_next_task()
        if task_id:
            run_task(task_id)
        else:
            time.sleep(1)


if __name__ == "__main__":
    main()
