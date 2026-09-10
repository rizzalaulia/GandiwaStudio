"""Behavior tests for the SQLite runtime foundation."""

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.main import app

API_ROOT = Path(__file__).resolve().parents[1]


def alembic_config(database_url: str) -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"DATABASE_URL": "postgresql://localhost/gandiwa"}, "SQLite"),
        ({"DATABASE_BUSY_TIMEOUT_MS": 0}, "greater than or equal to 1"),
    ],
)
def test_settings_reject_invalid_database_configuration(
    overrides: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        Settings(**overrides)


def test_sqlite_engine_applies_runtime_pragmas_from_backend_configuration(
    tmp_path: Path,
) -> None:
    database = tmp_path / "configured.sqlite3"
    settings = Settings(
        DATABASE_URL=f"sqlite:///{database}",
        DATABASE_BUSY_TIMEOUT_MS=7_500,
    )

    engine = create_sqlite_engine(settings)
    try:
        with engine.connect() as connection:
            foreign_keys = connection.execute(text("PRAGMA foreign_keys")).scalar_one()
            journal_mode = connection.execute(text("PRAGMA journal_mode")).scalar_one()
            busy_timeout = connection.execute(text("PRAGMA busy_timeout")).scalar_one()
    finally:
        engine.dispose()

    assert database.is_file()
    assert foreign_keys == 1
    assert journal_mode == "wal"
    assert busy_timeout == 7_500


def test_explicit_alembic_upgrade_creates_versioned_queue_schema(tmp_path: Path) -> None:
    database = tmp_path / "migrated.sqlite3"
    database_url = f"sqlite:///{database}"

    command.upgrade(alembic_config(database_url), "head")

    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        with engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            tables = set(inspect(connection).get_table_names())
    finally:
        engine.dispose()

    assert revision == "0002"
    assert "generation_job" in tables
    assert "creative_index" in tables


def test_migrated_generation_job_has_durable_queue_contract(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'queue.sqlite3'}"
    command.upgrade(alembic_config(database_url), "head")

    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        inspector = inspect(engine)
        columns = {column["name"]: column for column in inspector.get_columns("generation_job")}
        indexes = {index["name"]: index for index in inspector.get_indexes("generation_job")}
    finally:
        engine.dispose()

    required_columns = {
        "id",
        "job_type",
        "status",
        "priority",
        "provider_id",
        "model_id",
        "ruleset_snapshot_id",
        "parameters",
        "attempt_count",
        "remote_job_id",
        "lease_owner",
        "lease_expires_at",
        "heartbeat_at",
        "cancel_requested_at",
        "created_at",
        "started_at",
        "completed_at",
        "error_code",
        "redacted_error",
        "result_manifest",
    }
    assert required_columns <= columns.keys()
    assert columns["status"]["nullable"] is False
    assert columns["priority"]["nullable"] is False
    assert columns["attempt_count"]["nullable"] is False
    assert indexes["ix_generation_job_claim"]["column_names"] == [
        "status",
        "priority",
        "created_at",
    ]


def test_generation_job_uses_sqlalchemy_two_declarative_mapping() -> None:
    from gandiwa_api.models import Base, GenerationJob

    assert GenerationJob.__table__.metadata is Base.metadata
    assert GenerationJob.__tablename__ == "generation_job"


@pytest.mark.anyio
async def test_clean_migration_satisfies_readiness_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "ready.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    database_url = f"sqlite:///{database}"
    command.upgrade(alembic_config(database_url), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", database_url)
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/v1/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_alembic_downgrade_and_upgrade_are_explicit_and_reversible(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'reversible.sqlite3'}"
    config = alembic_config(database_url)

    command.upgrade(config, "head")
    command.downgrade(config, "base")

    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        assert "generation_job" not in inspect(engine).get_table_names()
    finally:
        engine.dispose()

    command.upgrade(config, "head")
    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        with engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
    finally:
        engine.dispose()

    assert revision == "0002"


def test_importing_application_does_not_create_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "startup.sqlite3"
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")

    assert app.title == "Gandiwa Studio API"
    assert not database.exists()
