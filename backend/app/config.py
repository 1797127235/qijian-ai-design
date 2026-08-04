from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://qijian:qijian@localhost:5433/qijian"
    upload_dir: Path = Path("data/uploads")
    development_designer_email: str = "designer@qijian.local"
    api_cors_origins: str = "http://localhost:5173"
    ai_base_url: str = "https://www.codex2api.com/v1"
    ai_api_key: str | None = None
    ai_model: str = "grok-4.5-latest"
    ai_request_timeout_seconds: int = 300
    ai_reasoning_effort: str = "low"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.api_cors_origins.split(",") if origin.strip()]


settings = Settings()
