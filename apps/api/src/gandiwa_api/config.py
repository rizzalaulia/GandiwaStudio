"""Configuration settings for the Gandiwa API probes."""

from pathlib import Path
from typing import Any

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime paths and configuration used by Gandiwa API and security boundaries."""

    model_config = SettingsConfigDict(env_prefix="GANDIWA_", extra="ignore")

    ENV: str = Field(
        default="development",
        validation_alias=AliasChoices("GANDIWA_ENV", "ENV"),
    )
    DATABASE_URL: str = "sqlite:///./var/gandiwa.sqlite3"
    DATABASE_BUSY_TIMEOUT_MS: int = 5_000
    ARTIFACT_DIR: Path = Path("./var/artifacts")
    SESSION_SECRET: str = Field(
        default="change-me-for-local-development",
        validation_alias=AliasChoices("GANDIWA_SESSION_SECRET", "SESSION_SECRET"),
    )
    SECURE_COOKIES: bool = Field(
        default=False,
        validation_alias=AliasChoices("GANDIWA_SECURE_COOKIES", "SECURE_COOKIES"),
    )
    ALLOWED_ORIGINS: list[str] = Field(
        default=["http://localhost:5173"],
        validation_alias=AliasChoices("GANDIWA_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"),
    )

    # Provider connector configurations (server-side only)
    NINEROUTER_BASE_URL: str | None = Field(
        default=None,
        validation_alias=AliasChoices("NINEROUTER_BASE_URL", "GANDIWA_NINEROUTER_BASE_URL"),
    )
    NINEROUTER_API_KEY: str | None = Field(
        default=None,
        validation_alias=AliasChoices("NINEROUTER_API_KEY", "GANDIWA_NINEROUTER_API_KEY"),
    )
    FAL_BASE_URL: str = Field(
        default="https://queue.fal.run",
        validation_alias=AliasChoices("FAL_BASE_URL", "GANDIWA_FAL_BASE_URL"),
    )
    FAL_KEY: str | None = Field(
        default=None,
        validation_alias=AliasChoices("FAL_KEY", "GANDIWA_FAL_KEY"),
    )

    @model_validator(mode="before")
    @classmethod
    def split_allowed_origins(cls, data: Any) -> Any:
        if isinstance(data, dict):
            origins = data.get("GANDIWA_ALLOWED_ORIGINS") or data.get("ALLOWED_ORIGINS")
            if isinstance(origins, str):
                data["ALLOWED_ORIGINS"] = [
                    origin.strip() for origin in origins.split(",") if origin.strip()
                ]
        return data

    @model_validator(mode="after")
    def validate_database_settings(self) -> "Settings":
        if not self.DATABASE_URL.startswith("sqlite:///"):
            raise ValueError("DATABASE_URL must use the SQLite scheme")
        if self.DATABASE_BUSY_TIMEOUT_MS < 1:
            raise ValueError("DATABASE_BUSY_TIMEOUT_MS must be greater than or equal to 1")
        return self

