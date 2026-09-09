"""Runtime configuration for the Gandiwa API security boundaries."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEVELOPMENT_SESSION_SECRET = "change-me-for-local-development"
INSECURE_SESSION_SECRET_VALUES = {
    "",
    "change-me",
    "change-me-for-local-development",
    "change_me",
    "changeme",
}


class Settings(BaseSettings):
    """Runtime settings. Production security settings fail closed."""

    model_config = SettingsConfigDict(env_prefix="GANDIWA_", extra="ignore")

    ENV: str = Field(default="development", validation_alias=AliasChoices("GANDIWA_ENV", "ENV"))
    DATABASE_URL: str = "sqlite:///./var/gandiwa.sqlite3"
    DATABASE_BUSY_TIMEOUT_MS: int = 5_000
    ARTIFACT_DIR: Path = Path("./var/artifacts")
    SESSION_SECRET: str = Field(
        default=DEVELOPMENT_SESSION_SECRET,
        validation_alias=AliasChoices("GANDIWA_SESSION_SECRET", "SESSION_SECRET"),
    )
    SECURE_COOKIES: bool = Field(
        default=False,
        validation_alias=AliasChoices("GANDIWA_SECURE_COOKIES", "SECURE_COOKIES"),
    )
    ALLOWED_ORIGINS: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"],
        validation_alias=AliasChoices("GANDIWA_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"),
    )

    # Provider connector configuration remains server-side only.
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

    @field_validator("ALLOWED_ORIGINS", mode="before")
    @classmethod
    def split_allowed_origins(cls, origins: Any) -> list[str]:
        if isinstance(origins, str):
            parsed = [origin.strip() for origin in origins.split(",") if origin.strip()]
        elif isinstance(origins, list) and all(isinstance(origin, str) for origin in origins):
            parsed = [origin.strip() for origin in origins if origin.strip()]
        else:
            raise ValueError("ALLOWED_ORIGINS must be a comma-separated string or string list")
        if not parsed or "*" in parsed:
            raise ValueError("ALLOWED_ORIGINS must contain explicit origins and cannot contain '*'")
        return parsed

    @model_validator(mode="after")
    def validate_security_settings(self) -> Settings:
        if not self.DATABASE_URL.startswith("sqlite:///"):
            raise ValueError("DATABASE_URL must use the SQLite scheme")
        if self.DATABASE_BUSY_TIMEOUT_MS < 1:
            raise ValueError("DATABASE_BUSY_TIMEOUT_MS must be greater than or equal to 1")

        is_production = self.ENV.strip().lower() == "production"
        if is_production:
            if (
                self.SESSION_SECRET.strip().lower() in INSECURE_SESSION_SECRET_VALUES
                or len(self.SESSION_SECRET) < 32
            ):
                raise ValueError(
                    "SESSION_SECRET must be a unique value of at least 32 characters in production"
                )
            if not self.SECURE_COOKIES:
                raise ValueError("SECURE_COOKIES must be true in production")
            if any(not origin.startswith("https://") for origin in self.ALLOWED_ORIGINS):
                raise ValueError("ALLOWED_ORIGINS must use HTTPS in production")
        return self
