"""Configuration settings for the Gandiwa API probes."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime paths and schema expectations used by readiness checks."""

    model_config = SettingsConfigDict(env_prefix="GANDIWA_", extra="ignore")

    DATABASE_URL: str = "sqlite:///./var/gandiwa.sqlite3"
    ARTIFACT_DIR: Path = Path("./var/artifacts")
