"""Configuration settings for the Gandiwa API probes."""

from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime paths and schema expectations used by readiness checks."""

    model_config = SettingsConfigDict(env_prefix="GANDIWA_", extra="ignore")

    DATABASE_URL: str = "sqlite:///./var/gandiwa.sqlite3"
    DATABASE_BUSY_TIMEOUT_MS: int = 5_000
    ARTIFACT_DIR: Path = Path("./var/artifacts")

    @model_validator(mode="after")
    def validate_database_settings(self) -> "Settings":
        if not self.DATABASE_URL.startswith("sqlite:///"):
            raise ValueError("DATABASE_URL must use the SQLite scheme")
        if self.DATABASE_BUSY_TIMEOUT_MS < 1:
            raise ValueError("DATABASE_BUSY_TIMEOUT_MS must be greater than or equal to 1")
        return self
