"""Disposable SQLite creative index rebuilt only from portable project manifests."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, insert

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.models import CreativeIndex
from gandiwa_api.project_manifest import rebuild_creative_index, validate_project_manifest


@dataclass(frozen=True)
class CreativeIndexRebuildResult:
    """Public result suitable for an actionable UI without leaking backend details."""

    indexed_entries: int
    findings: list[dict[str, str]]


def rebuild_creative_index_from_manifest(
    database_url: str,
    manifest_value: object,
) -> CreativeIndexRebuildResult:
    """Replace one project's disposable index after fully validating its manifest.

    The backend receives manifest data only, never a browser-local absolute folder path.
    Invalid references leave all existing SQLite index rows unchanged.
    """
    try:
        manifest = validate_project_manifest(manifest_value)
        entries = rebuild_creative_index(manifest)
    except ValueError as error:
        return CreativeIndexRebuildResult(
            indexed_entries=0,
            findings=[{"code": "invalid_manifest_reference", "message": str(error)}],
        )

    project_id = manifest["project_id"]
    engine = create_sqlite_engine(Settings(DATABASE_URL=database_url))
    try:
        with engine.begin() as connection:
            connection.execute(delete(CreativeIndex).where(CreativeIndex.project_id == project_id))
            if entries:
                connection.execute(
                    insert(CreativeIndex),
                    [
                        {
                            "project_id": project_id,
                            "asset_id": entry["asset_id"],
                            "content_type": entry["content_type"],
                            "revision": entry["revision"],
                            "relative_path": entry["relative_path"],
                        }
                        for entry in entries
                    ],
                )
    finally:
        engine.dispose()

    return CreativeIndexRebuildResult(indexed_entries=len(entries), findings=[])
