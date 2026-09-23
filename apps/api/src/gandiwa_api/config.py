"""Runtime configuration for the Gandiwa API security boundaries."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Annotated, Any

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
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
    WORKER_HEARTBEAT_STALE_SECONDS: int = 5
    ARTIFACT_DIR: Path = Path("./var/artifacts")
    ARTIFACT_RETENTION_HOURS: int = 24
    MAX_ARTIFACT_BYTES: int = 100 * 1024 * 1024
    SVG_QUARANTINE_DIR: Path = Path("./var/svg-quarantine").resolve()
    SVG_QUARANTINE_TTL_SECONDS: int = 3_600
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
    NINEROUTER_INSTANCES: Annotated[dict[str, str], NoDecode] | None = Field(
        default=None,
        validation_alias=AliasChoices("NINEROUTER_INSTANCES", "GANDIWA_NINEROUTER_INSTANCES"),
    )
    NINEROUTER_API_KEY_INSTANCE: dict[str, SecretStr] = Field(
        default_factory=dict,
        exclude=True,
        validation_alias=AliasChoices(
            "NINEROUTER_API_KEY_INSTANCE",
            "GANDIWA_NINEROUTER_API_KEY_INSTANCE",
        ),
    )

    FAL_BASE_URL: str = Field(
        default="https://queue.fal.run",
        validation_alias=AliasChoices("FAL_BASE_URL", "GANDIWA_FAL_BASE_URL"),
    )
    FAL_KEY: SecretStr | None = Field(
        default=None,
        exclude=True,
        validation_alias=AliasChoices("FAL_KEY", "GANDIWA_FAL_KEY"),
    )
    # Slice 2 (Issue #26): server-side encrypted provider key store location.
    PROVIDER_KEY_STORE: Path = Path("./var/provider-keys.json")

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

    @field_validator("NINEROUTER_INSTANCES", mode="before")
    @classmethod
    def parse_ninerouter_instances(cls, spec: Any) -> dict[str, str] | None:
        """Parse ``name=URL`` entries separated by ``;`` or newlines into a mapping."""
        if spec is None or spec == "":
            return None
        if isinstance(spec, dict) and all(
            isinstance(key, str) and isinstance(value, str) for key, value in spec.items()
        ):
            parsed = dict(spec)
        elif isinstance(spec, str):
            parsed = {}
            for entry in spec.replace("\n", ";").split(";"):
                entry = entry.strip()
                if not entry:
                    continue
                if "=" not in entry:
                    raise ValueError(
                        "NINEROUTER_INSTANCES must be 'name=URL' entries separated by ';'"
                    )
                name, url = entry.split("=", 1)
                name = name.strip().lower()
                url = url.strip()
                if not name or not url:
                    raise ValueError(
                        "NINEROUTER_INSTANCES must be 'name=URL' entries separated by ';'"
                    )
                parsed[name] = url
        else:
            raise ValueError(
                "NINEROUTER_INSTANCES must be a 'name=URL;…' string or a string mapping"
            )
        if not parsed:
            raise ValueError("NINEROUTER_INSTANCES must name at least one 'name=URL' entry")
        return parsed

    @model_validator(mode="after")
    def validate_ninerouter_instances(self) -> Settings:
        keys = dict(self.NINEROUTER_API_KEY_INSTANCE)
        # Sub-env per instance: GANDIWA_NINEROUTER_API_KEY_<NAME> (server-side only).
        for key, value in os.environ.items():
            if not key.startswith("GANDIWA_NINEROUTER_API_KEY_"):
                continue
            name = key[len("GANDIWA_NINEROUTER_API_KEY_") :]
            if name and re.fullmatch(r"[A-Z0-9]+(_[A-Z0-9]+)*", name):
                keys.setdefault(name, SecretStr(value))
        if self.NINEROUTER_INSTANCES is None:
            if keys:
                raise ValueError("NINEROUTER_API_KEY given without any NINEROUTER_INSTANCES")
            self.NINEROUTER_API_KEY_INSTANCE = {}
            return self
        known = {name.upper() for name in self.NINEROUTER_INSTANCES}
        for name in keys:
            env_form = name.upper()
            if env_form not in known and env_form.replace("_", "-") not in known:
                raise ValueError(f"NINEROUTER_API_KEY names an unknown instance: {name}")
        self.NINEROUTER_API_KEY_INSTANCE = {
            name: value if isinstance(value, SecretStr) else SecretStr(value)
            for name, value in keys.items()
        }
        return self

    def _instances_map(self) -> dict[str, str]:
        return self.NINEROUTER_INSTANCES or {}

    def ninerouter_instance_origins(self) -> dict[str, str]:
        """Named instance id to base URL mapping; server-side configuration only."""
        return dict(self._instances_map())

    def ninerouter_instance_api_key(self, instance_id: str) -> str | None:
        """Raw API key for one named instance; server-side transport use only."""
        key = instance_id.strip().upper()
        direct = self.NINEROUTER_API_KEY_INSTANCE.get(key)
        if direct is None:
            direct = self.NINEROUTER_API_KEY_INSTANCE.get(key.replace("-", "_"))
        return direct.get_secret_value() if direct is not None else None

    def fal_api_key(self) -> str | None:
        """Raw fal key for server-side transport injection only."""
        return self.FAL_KEY.get_secret_value() if self.FAL_KEY is not None else None

    @model_validator(mode="after")
    def validate_security_settings(self) -> Settings:
        if not self.DATABASE_URL.startswith("sqlite:///"):
            raise ValueError("DATABASE_URL must use the SQLite scheme")
        if self.DATABASE_BUSY_TIMEOUT_MS < 1:
            raise ValueError("DATABASE_BUSY_TIMEOUT_MS must be greater than or equal to 1")
        if self.WORKER_HEARTBEAT_STALE_SECONDS < 1:
            raise ValueError("WORKER_HEARTBEAT_STALE_SECONDS must be greater than or equal to 1")
        if self.ARTIFACT_RETENTION_HOURS < 1 or self.MAX_ARTIFACT_BYTES < 1:
            raise ValueError("artifact retention and byte limits must be positive")
        if not self.SVG_QUARANTINE_DIR.is_absolute():
            raise ValueError("SVG_QUARANTINE_DIR must be an absolute path")
        if self.SVG_QUARANTINE_TTL_SECONDS < 1:
            raise ValueError("SVG_QUARANTINE_TTL_SECONDS must be greater than or equal to 1")

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
