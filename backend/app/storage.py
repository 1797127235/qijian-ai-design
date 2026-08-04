import hashlib
import uuid
from pathlib import Path

from fastapi import UploadFile


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root

    async def save(self, project_id: uuid.UUID, upload: UploadFile, max_size_bytes: int) -> tuple[str, str, int]:
        content = await upload.read()
        if not content:
            raise ValueError("上传文件为空")
        if len(content) > max_size_bytes:
            raise ValueError("单个文件不能超过 20MB")

        suffix = Path(upload.filename or "").suffix.lower()
        object_key = f"{project_id}/{uuid.uuid4().hex}{suffix}"
        destination = self.root / object_key
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        return object_key, hashlib.sha256(content).hexdigest(), len(content)

    def delete(self, object_key: str) -> None:
        path = self.root / object_key
        if path.exists():
            path.unlink()

    def read_bytes(self, object_key: str) -> bytes:
        return (self.root / object_key).read_bytes()
