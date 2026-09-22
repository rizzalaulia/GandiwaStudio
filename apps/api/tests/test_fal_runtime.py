"""Offline fal.ai runtime wiring and secret-boundary contracts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.connectors.fal import FalClient
from gandiwa_api.connectors.runtime import build_generation_registry
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.security.providers import get_configured_providers


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: Any) -> dict[str, object]:
        self.calls.append(kwargs)
        return {"request_id": "unused"}


class FakeDownloader:
    def download(self, **kwargs: Any) -> bytes:
        raise AssertionError("not called in registry construction")


def settings_with_fal(tmp_path: Path) -> Settings:
    return Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'fal-runtime.sqlite3'}",
        ARTIFACT_DIR=tmp_path / "artifacts",
        FAL_BASE_URL="https://queue.fal.run",
        **{"FAL_KEY": "synthetic-fal-token"},
    )


def approve_official_fal(_url: str) -> tuple[str, int, list[object]]:
    return "queue.fal.run", 443, [object()]


def test_fal_key_is_secret_and_provider_listing_never_exposes_it(tmp_path: Path) -> None:
    settings = settings_with_fal(tmp_path)

    assert settings.fal_api_key() == "synthetic-fal-token"
    assert "synthetic-fal-token" not in repr(settings)
    assert "synthetic-fal-token" not in repr(settings.model_dump())
    providers = {item.id: item for item in get_configured_providers(settings)}
    assert providers["fal"].configured is True
    assert "synthetic-fal-token" not in repr(providers["fal"].model_dump())
    assert "queue.fal.run" not in repr(providers["fal"].model_dump())


def test_generation_registry_builds_only_fixed_fal_connector_and_injects_key(
    tmp_path: Path,
) -> None:
    settings = settings_with_fal(tmp_path)
    transport = FakeTransport()
    store = ArtifactStore(create_sqlite_engine(settings), settings.ARTIFACT_DIR)

    registry = build_generation_registry(
        settings,
        base_transport=transport,
        artifact_downloader=FakeDownloader(),
        artifact_store=store,
        origin_validator=approve_official_fal,
    )

    assert registry.registered_providers == ("fal",)
    connector = registry.resolve("fal")
    assert isinstance(connector, FalClient)
    wrapped = connector.transport
    wrapped.request(method="GET", path="/unused", payload=None, headers={})
    assert transport.calls[-1]["headers"] == {"Authorization": "Key synthetic-fal-token"}


def test_generation_registry_refuses_missing_key_transport_or_invalid_origin(
    tmp_path: Path,
) -> None:
    no_key = Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'no-key.sqlite3'}",
        ARTIFACT_DIR=tmp_path / "artifacts-no-key",
    )
    store = ArtifactStore(create_sqlite_engine(no_key), no_key.ARTIFACT_DIR)
    assert (
        build_generation_registry(
            no_key,
            base_transport=FakeTransport(),
            artifact_downloader=FakeDownloader(),
            artifact_store=store,
            origin_validator=approve_official_fal,
        ).registered_providers
        == ()
    )

    configured = settings_with_fal(tmp_path)
    configured_store = ArtifactStore(create_sqlite_engine(configured), configured.ARTIFACT_DIR)
    assert (
        build_generation_registry(
            configured,
            base_transport=None,
            artifact_downloader=FakeDownloader(),
            artifact_store=configured_store,
            origin_validator=approve_official_fal,
        ).registered_providers
        == ()
    )

    def reject(_url: str) -> tuple[str, int, list[object]]:
        raise ValueError("invalid")

    assert (
        build_generation_registry(
            configured,
            base_transport=FakeTransport(),
            artifact_downloader=FakeDownloader(),
            artifact_store=configured_store,
            origin_validator=reject,
        ).registered_providers
        == ()
    )

    with pytest.raises(LookupError):
        build_generation_registry(
            configured,
            base_transport=None,
            artifact_downloader=FakeDownloader(),
            artifact_store=configured_store,
            origin_validator=approve_official_fal,
        ).resolve("fal")
