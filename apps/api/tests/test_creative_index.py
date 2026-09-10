"""TDD coverage for rebuilding the disposable creative SQLite index."""

from __future__ import annotations

import json
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from gandiwa_api.config import Settings
from gandiwa_api.creative_index import rebuild_creative_index_from_manifest
from gandiwa_api.database import create_sqlite_engine

API_ROOT = Path(__file__).resolve().parents[1]


def alembic_config(database_url: str) -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "project-manifest"


def load_fixture(name: str) -> object:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def index_rows(database_url: str) -> list[tuple[object, ...]]:
    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        with engine.connect() as connection:
            return list(
                connection.execute(
                    text(
                        "SELECT project_id, asset_id, content_type, revision, relative_path "
                        "FROM creative_index ORDER BY project_id, asset_id, revision"
                    )
                )
            )
    finally:
        engine.dispose()


def test_rebuild_writes_only_portable_creative_fields_and_is_idempotent(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'creative-index.sqlite3'}"
    command.upgrade(alembic_config(database_url), "head")

    first = rebuild_creative_index_from_manifest(database_url, load_fixture("valid-minimal.json"))
    second = rebuild_creative_index_from_manifest(database_url, load_fixture("valid-minimal.json"))

    assert first.findings == []
    assert second.findings == []
    assert first.indexed_entries == 1
    assert second.indexed_entries == 1
    assert index_rows(database_url) == [
        (
            "6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1",
            "d6293da2-343a-4e85-98f3-29e2d1a04aa7",
            "illustration",
            1,
            "revisions/d6293da2-343a-4e85-98f3-29e2d1a04aa7/0001/master.png",
        )
    ]


def test_rebuild_keeps_other_project_index_rows(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'isolated-projects.sqlite3'}"
    command.upgrade(alembic_config(database_url), "head")
    first_manifest = load_fixture("valid-minimal.json")
    assert isinstance(first_manifest, dict)
    second_manifest = {**first_manifest, "project_id": "7a9d1305-143c-4055-aa0a-d1b1b240df4e"}

    rebuild_creative_index_from_manifest(database_url, first_manifest)
    rebuild_creative_index_from_manifest(database_url, second_manifest)
    rebuild_creative_index_from_manifest(database_url, first_manifest)

    assert len(index_rows(database_url)) == 2


def test_rebuild_reports_corrupt_manifest_without_changing_existing_index(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'corrupt-manifest.sqlite3'}"
    command.upgrade(alembic_config(database_url), "head")
    valid_manifest = load_fixture("valid-minimal.json")
    rebuild_creative_index_from_manifest(database_url, valid_manifest)
    before = index_rows(database_url)

    result = rebuild_creative_index_from_manifest(
        database_url,
        load_fixture("invalid-revision-outside-revisions.json"),
    )

    assert result.indexed_entries == 0
    assert result.findings == [
        {
            "code": "invalid_manifest_reference",
            "message": (
                "manifest.assets[0].revisions[0].relative_path must stay inside revisions/"
            ),
        }
    ]
    assert index_rows(database_url) == before


def test_rebuild_keeps_relative_paths_when_project_folder_moves(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'moved-project.sqlite3'}"
    command.upgrade(alembic_config(database_url), "head")

    result = rebuild_creative_index_from_manifest(database_url, load_fixture("valid-minimal.json"))

    assert result.findings == []
    stored_path = index_rows(database_url)[0][-1]
    assert stored_path == "revisions/d6293da2-343a-4e85-98f3-29e2d1a04aa7/0001/master.png"
    assert not str(stored_path).startswith("/")
