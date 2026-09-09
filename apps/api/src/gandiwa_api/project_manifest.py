"""Portable, secret-free project manifest contract for browser-owned folders.

This module deliberately uses only the Python standard library. Its TypeScript
counterpart consumes the same JSON fixtures under ``tests/fixtures``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, TypeGuard

type ProjectManifest = dict[str, Any]
type CreativeIndexEntry = dict[str, str | int]

_SCHEMA_VERSION = 1
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_PATH_SEGMENT_PATTERN = re.compile(r"^[^/\\\x00]+$")
_FORMATS = frozenset({"png", "jpeg", "svg"})
_CONTENT_TYPES = frozenset({"photo", "illustration", "vector"})
_CREATION_METHODS = frozenset({"camera", "manual_digital", "generative_ai", "mixed"})


def _is_object(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _require_object(value: object, context: str) -> Mapping[str, object]:
    if not _is_object(value):
        raise ValueError(f"{context} must be an object")
    return value


def _require_exact_keys(
    value: Mapping[str, object], expected: frozenset[str], context: str
) -> None:
    actual = frozenset(value)
    missing = expected - actual
    extra = actual - expected
    if missing or extra:
        raise ValueError(
            f"{context} keys must be exactly {sorted(expected)}; "
            f"missing={sorted(missing)}, extra={sorted(extra)}"
        )


def _require_string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{context} must be a non-empty string")
    return value


def _require_uuid(value: object, context: str) -> str:
    rendered = _require_string(value, context)
    if not _UUID_PATTERN.fullmatch(rendered):
        raise ValueError(f"{context} must be a lowercase canonical UUID")
    return rendered


def _require_creation_method(value: object, context: str) -> str:
    rendered = _require_string(value, context)
    if rendered not in _CREATION_METHODS:
        raise ValueError(f"{context} must be one of {sorted(_CREATION_METHODS)}")
    return rendered


def _require_format(value: object, context: str) -> str:
    rendered = _require_string(value, context)
    if rendered not in _FORMATS:
        raise ValueError(f"{context} must be one of {sorted(_FORMATS)}")
    return rendered


def _require_relative_path(value: object, context: str) -> str:
    path = _require_string(value, context)
    if path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", path):
        raise ValueError(f"{context} must not be an absolute path")
    if "\\" in path:
        raise ValueError(f"{context} must use portable '/' separators")
    segments = path.split("/")
    if any(
        segment in {"", ".", ".."} or not _PATH_SEGMENT_PATTERN.fullmatch(segment)
        for segment in segments
    ):
        raise ValueError(f"{context} must be a normalized relative path")
    return path


def _validate_format_route(content_type: str, revision: Mapping[str, object], context: str) -> None:
    generation = _require_format(revision["generation_format"], f"{context}.generation_format")
    working = _require_format(revision["working_format"], f"{context}.working_format")
    master = _require_format(revision["master_format"], f"{context}.master_format")
    submission = _require_format(revision["submission_format"], f"{context}.submission_format")

    if content_type == "vector":
        allowed = {"svg"}
        if {generation, working, master, submission} != allowed:
            raise ValueError(f"{context} vector revisions must use SVG for every format")
    elif content_type == "photo":
        if "svg" in {generation, working, master} or submission != "jpeg":
            raise ValueError(f"{context} photo revisions require raster work and JPEG submission")
    elif generation == "svg":
        if {generation, working, master, submission} != {"svg"}:
            raise ValueError(
                f"{context} native-vector illustration revisions must use SVG throughout"
            )
    elif "svg" in {working, master} or submission != "jpeg":
        raise ValueError(
            f"{context} raster illustration revisions require raster work and JPEG submission"
        )

    path = _require_relative_path(revision["relative_path"], f"{context}.relative_path")
    if not path.startswith("revisions/"):
        raise ValueError(f"{context}.relative_path must stay inside revisions/")
    if not path.endswith(f".{master}"):
        raise ValueError(f"{context}.relative_path extension must match master_format")


def validate_project_manifest(value: object) -> ProjectManifest:
    """Validate and return a portable manifest without normalizing user data."""
    manifest = _require_object(value, "manifest")
    _require_exact_keys(
        manifest,
        frozenset({"schema_version", "project_id", "project_name", "assets"}),
        "manifest",
    )
    schema_version = manifest["schema_version"]
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != _SCHEMA_VERSION
    ):
        raise ValueError(f"manifest.schema_version must equal {_SCHEMA_VERSION}")
    _require_uuid(manifest["project_id"], "manifest.project_id")
    _require_string(manifest["project_name"], "manifest.project_name")
    assets = manifest["assets"]
    if not isinstance(assets, Sequence) or isinstance(assets, (str, bytes, bytearray)):
        raise ValueError("manifest.assets must be an array")

    asset_ids: set[str] = set()
    relative_paths: set[str] = set()
    for asset_index, raw_asset in enumerate(assets):
        asset_context = f"manifest.assets[{asset_index}]"
        asset = _require_object(raw_asset, asset_context)
        _require_exact_keys(
            asset,
            frozenset({"asset_id", "content_type", "creation_method", "revisions"}),
            asset_context,
        )
        asset_id = _require_uuid(asset["asset_id"], f"{asset_context}.asset_id")
        if asset_id in asset_ids:
            raise ValueError(f"{asset_context}.asset_id must be unique")
        asset_ids.add(asset_id)
        content_type = _require_string(asset["content_type"], f"{asset_context}.content_type")
        if content_type not in _CONTENT_TYPES:
            raise ValueError(
                f"{asset_context}.content_type must be one of {sorted(_CONTENT_TYPES)}"
            )
        _require_creation_method(asset["creation_method"], f"{asset_context}.creation_method")
        revisions = asset["revisions"]
        if (
            not isinstance(revisions, Sequence)
            or isinstance(revisions, (str, bytes, bytearray))
            or not revisions
        ):
            raise ValueError(f"{asset_context}.revisions must be a non-empty array")

        revision_numbers: set[int] = set()
        for revision_index, raw_revision in enumerate(revisions):
            revision_context = f"{asset_context}.revisions[{revision_index}]"
            revision = _require_object(raw_revision, revision_context)
            _require_exact_keys(
                revision,
                frozenset(
                    {
                        "revision",
                        "generation_format",
                        "working_format",
                        "master_format",
                        "submission_format",
                        "relative_path",
                    }
                ),
                revision_context,
            )
            number = revision["revision"]
            if not isinstance(number, int) or isinstance(number, bool) or number < 1:
                raise ValueError(f"{revision_context}.revision must be a positive integer")
            if number in revision_numbers:
                raise ValueError(f"{revision_context}.revision must be unique per asset")
            revision_numbers.add(number)
            _validate_format_route(content_type, revision, revision_context)
            relative_path = _require_relative_path(
                revision["relative_path"], f"{revision_context}.relative_path"
            )
            if relative_path in relative_paths:
                raise ValueError(
                    f"{revision_context}.relative_path must be unique across the project"
                )
            relative_paths.add(relative_path)

    return dict(manifest)


def rebuild_creative_index(value: object) -> list[CreativeIndexEntry]:
    """Derive only portable creative index entries; durable backend state is excluded."""
    manifest = validate_project_manifest(value)
    return [
        {
            "asset_id": asset["asset_id"],
            "content_type": asset["content_type"],
            "revision": revision["revision"],
            "relative_path": revision["relative_path"],
        }
        for asset in manifest["assets"]
        for revision in asset["revisions"]
    ]
