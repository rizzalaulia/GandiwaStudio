"""TDD contracts for Issue #22 temporary artifact retention."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine


def _alembic_config(database_url: str) -> Config:
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture
def store(tmp_path: Path) -> ArtifactStore:
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    settings = Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'artifacts.sqlite3'}",
        ARTIFACT_DIR=artifact_dir,
    )
    command.upgrade(_alembic_config(settings.DATABASE_URL), "head")
    return ArtifactStore(create_sqlite_engine(settings), artifact_dir)


def test_stage_persists_owner_metadata_checksum_and_expiry(store: ArtifactStore) -> None:
    payload = b"generated image bytes"
    created = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="session-a",
        download_name="result.png",
        media_type="image/png",
        payload=payload,
        ttl_seconds=300,
    )

    record = store.get_for_owner(created.id, "session-a")

    assert record.job_id == "11111111-1111-1111-1111-111111111111"
    assert record.owner_session_id == "session-a"
    assert record.download_name == "result.png"
    assert record.media_type == "image/png"
    assert record.size_bytes == len(payload)
    assert record.sha256 == hashlib.sha256(payload).hexdigest()
    assert record.created_at.tzinfo is not None
    assert record.expires_at > datetime.now(UTC)
    assert store.private_path(record).read_bytes() == payload


def test_completed_retrieval_allows_reopen_before_expiry(store: ArtifactStore) -> None:
    created = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="session-a",
        download_name="result.png",
        media_type="image/png",
        payload=b"image",
        ttl_seconds=300,
    )
    store.claim_retrieval(created.id, "session-a", lease_seconds=60)

    store.complete_retrieval(created.id, "session-a")

    reopened = store.claim_retrieval(created.id, "session-a", lease_seconds=60)
    assert reopened.retrieved_at is not None


def test_cleanup_skips_active_retrieval_until_lease_expires(store: ArtifactStore) -> None:
    created = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="session-a",
        download_name="result.png",
        media_type="image/png",
        payload=b"image",
        ttl_seconds=1,
    )
    store.claim_retrieval(created.id, "session-a", lease_seconds=60)
    with store.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE temporary_artifact SET expires_at = ? WHERE id = ?",
            ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), created.id),
        )

    assert store.cleanup_expired() == 0
    assert store.private_path(created).is_file()

    with store.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE temporary_artifact SET retrieval_lease_expires_at = ? WHERE id = ?",
            ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), created.id),
        )
    assert store.cleanup_expired() == 1
    assert not store.private_path(created).exists()


def test_owner_mismatch_and_expiry_are_fail_closed(store: ArtifactStore) -> None:
    created = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="session-a",
        download_name="result.png",
        media_type="image/png",
        payload=b"image",
        ttl_seconds=300,
    )

    with pytest.raises(store.AccessDenied):
        store.get_for_owner(created.id, "session-b")

    with store.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE temporary_artifact SET expires_at = ? WHERE id = ?",
            ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), created.id),
        )
    with pytest.raises(store.ExpiredArtifact):
        store.get_for_owner(created.id, "session-a")
