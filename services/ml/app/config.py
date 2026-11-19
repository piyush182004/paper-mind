"""ML service settings (env vars / .env). No external API keys are needed: models run locally on CPU."""
from __future__ import annotations

from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Shared secret with the Node API (header X-Internal-Token). Required in production.
    ml_service_token: SecretStr | None = None
    environment: str = "development"

    embed_model: str = "BAAI/bge-small-en-v1.5"          # 384-dim, strong for its size, ONNX via fastembed
    rerank_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"  # small cross-encoder
    models_dir: str = "./data/models"
    embed_batch: int = 32

    max_pdf_mb: int = 40
    max_pdf_pages: int = 60
    # structured table extraction costs 1-5 s/page on CPU: bounded per PDF (0 pages disables it)
    pdf_table_pages: int = 6
    pdf_table_budget_s: float = 10.0
    max_texts_per_request: int = 512


@lru_cache
def get_settings() -> Settings:
    return Settings()
