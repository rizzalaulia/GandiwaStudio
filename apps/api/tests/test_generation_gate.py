"""Deterministic pre-generation gate tests (Issue #58).

The gate is deliberately pure: it never calls a provider, never writes durable
state, and never trusts prompt text alone for resolution. It only decides
whether a creative session is allowed to spend fal.ai credits.
"""

from __future__ import annotations

import pytest

from gandiwa_api.creative.generation_gate import (
    GENERATION_READY_CHECKS,
    evaluate_generation_readiness,
)
from gandiwa_api.creative.models import (
    CreativeSession,
    PromptSnapshot,
    StockConstraints,
)


def _valid_session() -> CreativeSession:
    return CreativeSession(
        topic="Minimal product still life",
        prompt=PromptSnapshot(
            prompt_text=(
                "Editorial product still life, ceramic mug on linen, "
                "soft window light, 4096x3112 target output"
            ),
            negative_prompt_text="logo, brand, watermark, random text, malformed anatomy",
            content_type="raster",
            creation_method="generative_ai",
            provider_id="fal",
            model_id="fal-ai/flux/schnell",
            target_width=4096,
            target_height=3112,
            aspect_ratio="4:3",
            orientation="landscape",
            stock_constraints=StockConstraints(
                no_logo=True,
                no_brand=True,
                no_watermark=True,
                no_random_text=True,
                no_fake_ui=True,
                no_unintentional_crop=True,
                no_malformed_anatomy=True,
                no_copyrighted_property=True,
                negative_space_decision="left third kept open for text",
            ),
        ),
    )


def test_passes_when_every_check_is_satisfied() -> None:
    decision = evaluate_generation_readiness(_valid_session())

    assert decision.ready is True
    assert decision.blockers == []
    assert [check.name for check in decision.checks] == list(GENERATION_READY_CHECKS)
    assert all(result.ok for result in decision.checks)


def test_blocks_when_prompt_text_is_empty() -> None:
    session = _valid_session()
    session.prompt.prompt_text = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert [check.name for check in decision.checks if not check.ok] == ["prompt_present"]
    assert "prompt_present" in decision.blockers


def test_blocks_when_negative_prompt_is_missing() -> None:
    session = _valid_session()
    session.prompt.negative_prompt_text = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "negative_prompt_present" in decision.blockers


def test_blocks_when_provider_and_model_are_not_explicit() -> None:
    session = _valid_session()
    session.prompt.provider_id = ""
    session.prompt.model_id = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "provider_model_explicit" in decision.blockers


def test_blocks_when_content_type_and_creation_method_are_missing() -> None:
    session = _valid_session()
    session.prompt.content_type = ""
    session.prompt.creation_method = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "content_type_and_creation_method" in decision.blockers


def test_blocks_when_target_resolution_is_below_four_megapixels() -> None:
    session = _valid_session()
    session.prompt.target_width = 1024
    session.prompt.target_height = 768

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "resolution_target" in decision.blockers


def test_blocks_when_resolution_is_in_prompt_but_dimensions_are_unset() -> None:
    session = _valid_session()
    session.prompt.target_width = 0
    session.prompt.target_height = 0

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "resolution_target" in decision.blockers


def test_blocks_when_aspect_ratio_or_orientation_is_missing() -> None:
    session = _valid_session()
    session.prompt.aspect_ratio = ""
    session.prompt.orientation = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "aspect_ratio_and_orientation" in decision.blockers


def test_blocks_when_stock_constraints_are_absent() -> None:
    session = _valid_session()
    session.prompt.stock_constraints = None

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "stock_constraints_present" in decision.blockers


def test_blocks_when_negative_space_decision_is_unrecorded() -> None:
    session = _valid_session()
    assert session.prompt.stock_constraints is not None
    session.prompt.stock_constraints.negative_space_decision = ""

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "stock_constraints_present" in decision.blockers


def test_blocks_when_prompt_contains_unresolved_placeholder() -> None:
    session = _valid_session()
    session.prompt.prompt_text = "Editorial still life of <subject>, 4096x3112"

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert "no_unresolved_placeholders" in decision.blockers


@pytest.mark.parametrize(
    ("model_id", "expected_ok"),
    [
        ("fal-ai/flux/schnell", True),
        ("fal-ai/flux/dev", True),
        ("fal-ai/flux-realism", True),
        ("fal-ai/imagen", True),
        ("fal-ai/sdxl", True),
        ("text-only-model", False),
        ("fal-ai/whisper", False),
        ("", False),
    ],
)
def test_capability_match_with_selected_model(model_id: str, expected_ok: bool) -> None:
    session = _valid_session()
    session.prompt.model_id = model_id

    decision = evaluate_generation_readiness(session)

    matching = [check for check in decision.checks if check.name == "capability_match"]
    assert len(matching) == 1
    assert matching[0].ok is expected_ok
    if not expected_ok:
        assert decision.ready is False
        assert "capability_match" in decision.blockers


def test_accepts_a_future_provider_model_when_its_capability_is_explicitly_registered() -> None:
    session = _valid_session()
    session.prompt.provider_id = "futuregen"
    session.prompt.model_id = "futuregen/ultra-image"

    decision = evaluate_generation_readiness(
        session,
        image_capable_models={"futuregen/ultra-image"},
    )

    assert decision.ready is True
    assert decision.blockers == []


def test_aggregates_every_blocking_failure_in_order() -> None:
    session = _valid_session()
    session.prompt.prompt_text = "Draft of <subject>"
    session.prompt.negative_prompt_text = ""
    session.prompt.provider_id = ""
    session.prompt.model_id = "text-only-model"
    session.prompt.target_width = 800
    session.prompt.target_height = 600
    session.prompt.aspect_ratio = ""
    session.prompt.orientation = ""
    session.prompt.content_type = ""
    session.prompt.creation_method = ""
    session.prompt.stock_constraints = None

    decision = evaluate_generation_readiness(session)

    assert decision.ready is False
    assert decision.blockers == [
        "negative_prompt_present",
        "provider_model_explicit",
        "content_type_and_creation_method",
        "resolution_target",
        "aspect_ratio_and_orientation",
        "stock_constraints_present",
        "no_unresolved_placeholders",
        "capability_match",
    ]


def test_decision_is_independent_of_prompt_approval() -> None:
    """The gate is a necessary condition; approval is a separate human contract."""
    decision = evaluate_generation_readiness(_valid_session())

    assert decision.ready is True
    assert not hasattr(decision, "prompt_approved")
