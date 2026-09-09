"""Cross-language conformance fixtures for the portable project manifest."""

from __future__ import annotations

import json
from pathlib import Path

from gandiwa_api.project_manifest import rebuild_creative_index, validate_project_manifest

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "project-manifest"


def load_fixture(name: str) -> object:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_valid_minimal_fixture_is_accepted() -> None:
    manifest = validate_project_manifest(load_fixture("valid-minimal.json"))

    assert manifest["schema_version"] == 1
    assert manifest["assets"][0]["content_type"] == "illustration"
    assert manifest["assets"][0]["revisions"][0]["relative_path"].startswith("revisions/")


def test_revision_path_must_stay_inside_revisions_folder() -> None:
    invalid_manifest = load_fixture("invalid-revision-outside-revisions.json")

    try:
        validate_project_manifest(invalid_manifest)
    except ValueError as error:
        assert "relative_path" in str(error)
    else:
        raise AssertionError("a revision outside revisions/ must be rejected")


def test_absolute_revision_path_is_rejected_as_an_absolute_path() -> None:
    manifest = load_fixture("invalid-absolute-path.json")

    try:
        validate_project_manifest(manifest)
    except ValueError as error:
        assert "must not be an absolute path" in str(error)
    else:
        raise AssertionError("an absolute revision path must be rejected")


def test_rebuild_creative_index_keeps_only_portable_creative_fields() -> None:
    manifest = load_fixture("valid-minimal.json")

    assert rebuild_creative_index(manifest) == [
        {
            "asset_id": "d6293da2-343a-4e85-98f3-29e2d1a04aa7",
            "content_type": "illustration",
            "revision": 1,
            "relative_path": "revisions/d6293da2-343a-4e85-98f3-29e2d1a04aa7/0001/master.png",
        }
    ]


def test_python_accepts_and_rejects_the_shared_conformance_corpus() -> None:
    suite = load_fixture("conformance.json")
    assert isinstance(suite, dict)
    assert suite["schema_version"] == 1
    assert isinstance(suite["cases"], list)

    for case in suite["cases"]:
        assert isinstance(case, dict)
        fixture = load_fixture(case["fixture"])
        if case["valid"]:
            validate_project_manifest(fixture)
        else:
            try:
                validate_project_manifest(fixture)
            except ValueError:
                continue
            raise AssertionError(f"fixture {case['fixture']} must be rejected")
