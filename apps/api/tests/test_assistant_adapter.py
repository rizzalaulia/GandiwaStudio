"""9Router assistant adapter tests (Issue #58).

The adapter is the ONLY surface through which assistant intelligence enters
Gandiwa. Every response must be schema-validated. Malformed, schema-invalid,
or timed-out responses fail closed and never reach fal.ai.

These tests use a fake assistant transport: no live provider credential is
ever used (the acceptance criteria forbid it).
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from gandiwa_api.creative.assistant_adapter import (
    AssistantError,
    AssistantOperation,
    brainstorm,
    finalize_prompt,
    suggest_metadata,
)


class FakeAssistantTransport:
    """Records calls and returns canned responses; never touches the network."""

    def __init__(self, responses: dict[str, Any]) -> None:
        self._responses = responses
        self.calls: list[dict[str, Any]] = []

    def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append({"operation": operation, "payload": payload})
        if operation not in self._responses:
            raise AssistantError(f"unexpected operation {operation}")
        response = self._responses[operation]
        if isinstance(response, Exception):
            raise response
        return response


def _transport(operation: str, model_id: str) -> FakeAssistantTransport:
    canned: dict[str, Any] = {
        "brainstorm": {
            "model": model_id,
            "questions": [
                "What feeling should the image evoke?",
                "Who is the viewer?",
                "Where does the light come from?",
            ],
            "recommendation": "Narrow the subject to a single hero object.",
        },
        "finalize_prompt": {
            "model": model_id,
            "prompt_text": "Editorial still life, ceramic mug on linen, soft window light",
            "negative_prompt_text": "logo, brand, watermark, random text",
        },
        "suggest_metadata": {
            "model": model_id,
            "title": "Ceramic mug still life",
            "keywords": ["mug", "ceramic", "still life"],
            "release_group": "editorial",
        },
    }
    return FakeAssistantTransport({operation: canned[operation]})


def test_brainstorm_returns_three_questions_and_one_recommendation() -> None:
    transport = _transport("brainstorm", "9router-reasoning")
    payload = {"topic": "Product still life", "round": 1, "history": []}

    result = brainstorm(transport, payload)

    assert len(result.questions) == 3
    assert len(set(result.questions)) == 3
    assert result.recommendation  # non-empty
    assert result.model_id == "9router-reasoning"
    assert transport.calls[0]["operation"] == "brainstorm"


def test_brainstorm_rejects_fewer_than_three_questions() -> None:
    transport = FakeAssistantTransport(
        {
            "brainstorm": {
                "model": "9router-reasoning",
                "questions": ["only one?"],
                "recommendation": "narrow the subject",
            }
        }
    )

    with pytest.raises(AssistantError):
        brainstorm(transport, {"topic": "Product still life", "round": 1, "history": []})


def test_brainstorm_rejects_duplicate_questions() -> None:
    transport = FakeAssistantTransport(
        {
            "brainstorm": {
                "model": "9router-reasoning",
                "questions": ["same?", "same?", "other?"],
                "recommendation": "narrow",
            }
        }
    )

    with pytest.raises(AssistantError):
        brainstorm(transport, {"topic": "Product still life", "round": 1, "history": []})


def test_finalize_prompt_returns_prompt_and_negative_prompt() -> None:
    transport = _transport("finalize_prompt", "9router-reasoning")
    payload = {"concept": "ceramic mug on linen, soft window light"}

    result = finalize_prompt(transport, payload)

    assert result.prompt_text  # non-empty
    assert result.negative_prompt_text  # non-empty


def test_finalize_prompt_rejects_missing_negative_prompt() -> None:
    transport = FakeAssistantTransport(
        {
            "finalize_prompt": {
                "model": "9router-reasoning",
                "prompt_text": "ceramic mug on linen",
                "negative_prompt_text": "",
            }
        }
    )

    with pytest.raises(AssistantError):
        finalize_prompt(transport, {"concept": "ceramic mug on linen"})


def test_suggest_metadata_returns_title_keywords_and_release_group() -> None:
    transport = _transport("suggest_metadata", "9router-reasoning")
    payload = {"prompt_text": "ceramic mug on linen", "content_type": "raster"}

    result = suggest_metadata(transport, payload)

    assert result.title  # non-empty
    assert result.release_group in {"editorial", "commercial", "social", "decor"}


def test_suggest_metadata_rejects_unknown_release_group() -> None:
    transport = FakeAssistantTransport(
        {
            "suggest_metadata": {
                "model": "9router-reasoning",
                "title": "Mug still life",
                "keywords": ["mug", "ceramic"],
                "release_group": "forbidden",
            }
        }
    )

    with pytest.raises(AssistantError):
        suggest_metadata(transport, {"prompt_text": "ceramic mug", "content_type": "raster"})


def test_malformed_json_response_fails_closed() -> None:
    class Malformed:
        def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
            raise json.JSONDecodeError("expecting value", "doc", 0)

    with pytest.raises(AssistantError):
        brainstorm(Malformed(), {"topic": "x", "round": 1, "history": []})


def test_timeout_fails_closed_and_is_marked_unreachable() -> None:
    class TimedOut:
        def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
            raise AssistantError("assistant unreachable: timed out after 20s")

    with pytest.raises(AssistantError) as excinfo:
        finalize_prompt(TimedOut(), {"concept": "mug"})

    assert "unreachable" in str(excinfo.value)


def test_unexpected_operation_is_never_dispatched() -> None:
    transport = FakeAssistantTransport({})

    with pytest.raises(AssistantError):
        brainstorm(transport, {"topic": "x", "round": 1, "history": []})


def test_assistant_error_message_never_leaks_credentials() -> None:
    transport = FakeAssistantTransport(
        {"finalize_prompt": AssistantError("upstream 401 with key sk-test-1234")}
    )

    with pytest.raises(AssistantError) as excinfo:
        finalize_prompt(transport, {"concept": "mug"})

    assert "sk-test-1234" not in str(excinfo.value)


def test_operations_are_the_bounded_assistant_surface() -> None:
    assert {operation.value for operation in AssistantOperation} == {
        "brainstorm",
        "finalize_prompt",
        "analyze_image",
        "suggest_metadata",
    }


def test_assistant_result_model_exposes_model_id_and_operation() -> None:
    transport = _transport("brainstorm", "9router-reasoning")

    result = brainstorm(transport, {"topic": "mug", "round": 1, "history": []})

    assert result.model_id == "9router-reasoning"
    assert result.operation == "brainstorm"


def test_analyze_image_is_advisory_and_cannot_set_a_gate_verdict() -> None:
    """Vision analysis never produces a durable verdict; it is a recommendation."""
    from gandiwa_api.creative.assistant_adapter import analyze_image

    transport = FakeAssistantTransport(
        {
            "analyze_image": {
                "model": "9router-vision",
                "summary": "composition holds, no watermark detected",
                "concerns": ["left edge slightly tight"],
                "blocker": False,
            }
        }
    )

    result = analyze_image(transport, {"image_token": "abc", "prompt_text": "mug on linen"})

    assert result.blocker is False
    assert result.summary
    assert result.concerns == ["left edge slightly tight"]
    assert result.model_id == "9router-vision"
    assert not hasattr(result, "verdict")
    assert not hasattr(result, "audit_status")
    assert not hasattr(result, "adobe_ready")
