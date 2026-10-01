"""Offline OpenAI Image runtime wiring contracts for Issue #65."""

from __future__ import annotations

from pathlib import Path

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.connectors.openai import OpenAIImageClient
from gandiwa_api.connectors.runtime import build_generation_registry
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.security.providers import get_configured_providers


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {"data": [{"b64_json": "unused"}]}


class FakeDownloader:
    def download(self, **_kwargs: object) -> bytes:
        raise AssertionError("not called in registry construction")


def openai_settings(tmp_path: Path) -> Settings:
    return Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'openai-runtime.sqlite3'}",
        ARTIFACT_DIR=tmp_path / "artifacts",
        **{"OPENAI_API_KEY": "synthetic-openai-token"},
    )


def test_openai_image_key_is_secret_and_provider_listing_exposes_only_masked_state(
    tmp_path: Path,
) -> None:
    settings = openai_settings(tmp_path)

    assert settings.openai_api_key() == "synthetic-openai-token"
    assert "synthetic-openai-token" not in repr(settings)
    assert "synthetic-openai-token" not in repr(settings.model_dump())

    providers = {item.id: item for item in get_configured_providers(settings)}

    assert providers["openai"].name == "OpenAI Image API"
    assert providers["openai"].configured is True
    assert providers["openai"].auth_required is True
    assert "synthetic-openai-token" not in repr(providers["openai"].model_dump())


def test_generation_registry_registers_openai_without_fal_fallback(tmp_path: Path) -> None:
    settings = openai_settings(tmp_path)
    transport = FakeTransport()
    store = ArtifactStore(create_sqlite_engine(settings), settings.ARTIFACT_DIR)

    registry = build_generation_registry(
        settings,
        base_transport=transport,
        artifact_downloader=FakeDownloader(),
        artifact_store=store,
    )

    assert registry.registered_providers == ("openai",)
    connector = registry.resolve("openai")
    assert isinstance(connector, OpenAIImageClient)
    connector.transport.request(method="GET", path="/unused", payload=None, headers={})
    assert transport.calls[-1]["headers"] == {"Authorization": "Bearer synthetic-openai-token"}


def test_generation_registry_refuses_openai_when_its_key_or_transport_is_missing(
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
        ).registered_providers
        == ()
    )
    assert (
        build_generation_registry(
            openai_settings(tmp_path),
            base_transport=None,
            artifact_downloader=FakeDownloader(),
            artifact_store=ArtifactStore(
                create_sqlite_engine(openai_settings(tmp_path)), tmp_path / "connected-artifacts"
            ),
        ).registered_providers
        == ()
    )
