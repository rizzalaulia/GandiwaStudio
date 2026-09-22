"""Human creative-approval evidence tests (Issue #58)."""

from __future__ import annotations

import pytest

from gandiwa_api.creative.approval import (
    approve_exact_prompt,
    current_prompt_digest,
)
from gandiwa_api.creative.models import CreativeSession, PromptSnapshot, StockConstraints


def session() -> CreativeSession:
    return CreativeSession(
        topic="mug",
        prompt=PromptSnapshot(
            prompt_text="Ceramic mug on linen, 2400x1667",
            negative_prompt_text="logo, watermark",
            content_type="raster",
            creation_method="generative_ai",
            provider_id="fal",
            model_id="fal-ai/flux/dev",
            target_width=2400,
            target_height=1667,
            aspect_ratio="3:2",
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
                negative_space_decision="right third open",
            ),
        ),
    )


def test_prompt_approval_records_human_timestamp_and_exact_digest() -> None:
    current = session()

    record = approve_exact_prompt(current, human="Guru", approved_at="2026-09-16T07:00:00Z")

    assert record.stage == "prompt"
    assert record.human == "Guru"
    assert record.approved_at == "2026-09-16T07:00:00Z"
    assert record.prompt_digest == current_prompt_digest(current)
    assert current.human_prompt_approval is True
    assert current.approved_prompt_digest == record.prompt_digest
    assert current.creative_approvals == [record]


def test_prompt_approval_refuses_empty_human_or_timestamp() -> None:
    with pytest.raises(ValueError):
        approve_exact_prompt(session(), human="", approved_at="2026-09-16T07:00:00Z")
    with pytest.raises(ValueError):
        approve_exact_prompt(session(), human="Guru", approved_at="")


def test_new_prompt_after_approval_invalidates_approval_digest() -> None:
    current = session()
    approve_exact_prompt(current, human="Guru", approved_at="2026-09-16T07:00:00Z")

    current.prompt.prompt_text = "Changed ceramic mug composition, 2400x1667"

    assert current.approved_prompt_digest != current_prompt_digest(current)
