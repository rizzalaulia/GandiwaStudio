"""Configuration settings for Gandiwa API."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GANDIWA_", extra="ignore")

    ENV: str = "development"
    VERSION: str = "0.1.0"
    DATABASE_PATH: Path = Path("/tmp/gandiwa.sqlite3")
    ARTIFACT_DIR: Path = Path("/tmp/gandiwa_artifacts")


settings = Settings()
