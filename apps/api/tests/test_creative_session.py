"""Creative session sidecar tests (Issue #58).

The sidecar is project-local and versioned, and lives OUTSIDE manifest v1.
It is the durable record of the creative laku: topic, brainstorm rounds,
human answers, approved concept, immutable prompt snapshot once dispatched,
generation provenance, vision review, metadata suggestion, approvals.

Covered in this slice: prompt snapshot immutability and regenerate-as-new-revision.
Durable write boundaries belong to the browser-local project folder contract
and are covered by the Stage 4 metadata/approval regression suite.
"""

from __future__ import annotations

import pytest

from gandiwa_api.creative.models import (
    PromptSnapshot,
    StockConstraints,
)
from gandiwa_api.creative.session import (
    PromptSnapshotFrozen,
    SessionService,
    import_prompt_from_assistant,
    record_generation_provenance,
    record_vision_review,
    start_session,
)


def _stock() -> StockConstraints:
    return StockConstraints(
        no_logo=True,
        no_brand=True,
        no_watermark=True,
        no_random_text=True,
        no_fake_ui=True,
        no_unintentional_crop=True,
        no_malformed_anatomy=True,
        no_copyrighted_property=True,
        negative_space_decision="left third open",
    )


def _prompt() -> PromptSnapshot:
    return PromptSnapshot(
        prompt_text="Editorial still life, ceramic mug on linen, 4096x3112",
        negative_prompt_text="logo, brand, watermark, random text",
        content_type="raster",
        creation_method="generative_ai",
        provider_id="fal",
        model_id="fal-ai/flux/schnell",
        target_width=4096,
        target_height=3112,
        aspect_ratio="4:3",
        orientation="landscape",
        stock_constraints=_stock(),
    )


def test_start_session_records_topic_and_empty_prompt() -> None:
    session = start_session("Product still life")

    assert session.topic == "Product still life"
    assert session.prompt.prompt_text == ""
    assert session.dispatched is False
    assert session.revisions == []


def test_import_prompt_from_assistant_fills_prompt_fields() -> None:
    session = start_session("Product still life")

    session = import_prompt_from_assistant(
        session,
        prompt_text="Editorial still life, ceramic mug on linen, 4096x3112",
        negative_prompt_text="logo, brand, watermark",
        content_type="raster",
        creation_method="generative_ai",
        provider_id="fal",
        model_id="fal-ai/flux/schnell",
        target_width=4096,
        target_height=3112,
        aspect_ratio="4:3",
        orientation="landscape",
        stock_constraints=_stock(),
    )

    assert session.prompt.prompt_text.startswith("Editorial still life")
    assert session.prompt.target_width == 4096
    assert session.prompt.stock_constraints is not None
    assert session.prompt.stock_constraints.no_watermark is True


def test_prompt_snapshot_becomes_immutable_once_dispatched() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    session.dispatch()

    with pytest.raises(PromptSnapshotFrozen):
        session.import_prompt(_prompt())

    with pytest.raises(PromptSnapshotFrozen):
        session.replace_prompt_text("a totally different prompt")


def test_dispatch_records_prompt_snapshot_and_provenance_placeholder() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())

    record = session.dispatch()

    assert record.prompt_text == _prompt().prompt_text
    assert record.target_width == 4096
    assert session.dispatched is True


def test_regenerate_creates_new_revision_and_freezes_the_old_snapshot() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    first = session.dispatch()

    session.regenerate(new_prompt_text="Editorial still life, mug, warm tone, 4096x3112")

    assert len(session.revisions) == 2
    assert session.revisions[0].prompt_text == first.prompt_text
    assert session.revisions[1].prompt_text != first.prompt_text
    assert session.dispatched is True


def test_regenerate_refuses_identical_prompt_without_recorded_rejection() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    session.dispatch()

    with pytest.raises(ValueError, match="meaningful change"):
        session.regenerate(new_prompt_text=_prompt().prompt_text)


def test_regenerate_accepts_identical_prompt_when_rejection_is_recorded() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    session.dispatch()

    session.regenerate(
        new_prompt_text=_prompt().prompt_text,
        rejection_reason="previous output had a watermark-like artifact",
    )

    assert len(session.revisions) == 2
    assert session.revisions[1].rejection_reason is not None


def test_record_generation_provenance_binds_revision() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    session.dispatch()

    record_generation_provenance(
        session,
        provider_job_id="fal-job-abc123",
        seed=42,
        parameters={"num_inference_steps": 4},
        adapter_version="9router-1.0.0",
    )

    revision = session.current_revision
    assert revision is not None
    assert revision.provenance is not None
    assert revision.provenance.provider_job_id == "fal-job-abc123"
    assert revision.provenance.seed == 42


def test_record_vision_review_is_advisory_and_cannot_set_a_verdict() -> None:
    session = SessionService(start_session("mug"))
    session.import_prompt(_prompt())
    session.dispatch()

    review = record_vision_review(
        session,
        summary="composition holds",
        concerns=["left edge slightly tight"],
        blocker=False,
    )

    assert review.blocker is False
    assert not hasattr(review, "verdict")
    assert not hasattr(review, "audit_status")
    assert not hasattr(review, "adobe_ready")


def test_session_sidecar_stays_outside_manifest_v1() -> None:
    """The sidecar never mutates the manifest schema."""
    session = start_session("mug")

    serialized = session.model_dump()

    assert "project_id" not in serialized
    assert "assets" not in serialized
    assert "revisions" in serialized
