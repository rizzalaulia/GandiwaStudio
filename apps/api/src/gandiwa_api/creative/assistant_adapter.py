"""9Router assistant adapter (Issue #58).

The ONLY surface through which assistant intelligence enters Gandiwa. Four
bounded operations: brainstorm, finalize_prompt, analyze_image, suggest_metadata.

Every response is schema-validated. Malformed, schema-invalid, or timed-out
upstream responses fail closed as AssistantError and can never reach fal.ai.

No live provider credential is used in tests: a fake transport supplies
canned responses. Credential redaction is enforced here so an upstream 401
body never leaks into a UI-facing message.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol


class AssistantOperation(Enum):
    """Bounded assistant surface; anything else is refused."""

    brainstorm = "brainstorm"
    finalize_prompt = "finalize_prompt"
    analyze_image = "analyze_image"
    suggest_metadata = "suggest_metadata"


class AssistantTransport(Protocol):
    """Carrier-bound transport contract; never holds credentials in memory."""

    def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Send one assistant request and return the parsed upstream JSON."""
        ...


@dataclass(frozen=True)
class BrainstormResult:
    model_id: str
    operation: str
    questions: list[str]
    recommendation: str


@dataclass(frozen=True)
class FinalPromptResult:
    model_id: str
    operation: str
    prompt_text: str
    negative_prompt_text: str


@dataclass(frozen=True)
class AnalyzeImageResult:
    """Vision analysis is advisory only; it carries no gate or audit verdict."""

    model_id: str
    operation: str
    summary: str
    concerns: list[str]
    blocker: bool


@dataclass(frozen=True)
class MetadataSuggestion:
    model_id: str
    operation: str
    title: str
    keywords: list[str]
    release_group: str


_RELEASE_GROUPS = frozenset({"editorial", "commercial", "social", "decor"})
_SECRET_PATTERN = re.compile(r"(?i)(sk-|api[_-]?key|bearer\s|token)[^\s]{4,}")


class AssistantError(RuntimeError):
    """Raised when the assistant response cannot be trusted."""

    def __init__(self, message: str) -> None:
        super().__init__(_redact(message))


def _redact(text: str) -> str:
    sanitized = _SECRET_PATTERN.sub("[REDACTED]", text)
    return sanitized


def _safe_json(response: Any) -> dict[str, Any]:
    """Translate transport-level parsing failures into a fail-closed error."""
    if not isinstance(response, dict):
        raise AssistantError("assistant response is not a JSON object")
    return response


class _SafeRequester:
    """Wraps a transport so parse errors and timeouts become AssistantError."""

    def __init__(self, transport: AssistantTransport) -> None:
        self._transport = transport

    def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._transport.request(operation, payload)
        except json.JSONDecodeError as error:
            raise AssistantError("assistant response was not valid JSON") from error
        except TimeoutError as error:
            raise AssistantError("assistant unreachable: timed out") from error
        except AssistantError:
            raise
        except Exception as error:
            raise AssistantError("assistant request failed") from error
        return _safe_json(response)


def _require_fields(body: dict[str, Any], fields: tuple[str, ...]) -> None:
    for name in fields:
        if name not in body:
            raise AssistantError(f"assistant response missing required field {name}")


def _require_str(body: dict[str, Any], name: str) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not value.strip():
        raise AssistantError(f"assistant field {name} must be a non-empty string")
    return value


def _require_str_list(body: dict[str, Any], name: str) -> list[str]:
    value = body.get(name)
    if not isinstance(value, list):
        raise AssistantError(f"assistant field {name} must be a list")
    if not all(isinstance(item, str) for item in value):
        raise AssistantError(f"assistant field {name} must be a list of strings")
    return value


def _require_model(body: dict[str, Any]) -> str:
    return _require_str(body, "model")


def brainstorm(
    transport: AssistantTransport, payload: dict[str, Any]
) -> BrainstormResult:
    """3-in-1 round: exactly three distinct questions plus one recommendation."""
    requester = _SafeRequester(transport)
    body = requester.request("brainstorm", payload)
    _require_fields(body, ("model", "questions", "recommendation"))
    questions = _require_str_list(body, "questions")
    if len(questions) != 3:
        raise AssistantError("brainstorm must return exactly three questions")
    if len(set(questions)) != 3:
        raise AssistantError("brainstorm questions must be distinct")
    return BrainstormResult(
        model_id=_require_model(body),
        operation="brainstorm",
        questions=questions,
        recommendation=_require_str(body, "recommendation"),
    )


def finalize_prompt(
    transport: AssistantTransport, payload: dict[str, Any]
) -> FinalPromptResult:
    """Author the production prompt and its negative prompt."""
    requester = _SafeRequester(transport)
    body = requester.request("finalize_prompt", payload)
    _require_fields(body, ("model", "prompt_text", "negative_prompt_text"))
    return FinalPromptResult(
        model_id=_require_model(body),
        operation="finalize_prompt",
        prompt_text=_require_str(body, "prompt_text"),
        negative_prompt_text=_require_str(body, "negative_prompt_text"),
    )


def analyze_image(
    transport: AssistantTransport, payload: dict[str, Any]
) -> AnalyzeImageResult:
    """Advisory vision check. It never sets an audit verdict or gate state."""
    requester = _SafeRequester(transport)
    body = requester.request("analyze_image", payload)
    _require_fields(body, ("model", "summary", "concerns", "blocker"))
    return AnalyzeImageResult(
        model_id=_require_model(body),
        operation="analyze_image",
        summary=_require_str(body, "summary"),
        concerns=_require_str_list(body, "concerns"),
        blocker=bool(body.get("blocker", False)),
    )


def suggest_metadata(
    transport: AssistantTransport, payload: dict[str, Any]
) -> MetadataSuggestion:
    """Metadata suggestion; durable writes only after human confirmation."""
    requester = _SafeRequester(transport)
    body = requester.request("suggest_metadata", payload)
    _require_fields(body, ("model", "title", "keywords", "release_group"))
    release_group = _require_str(body, "release_group")
    if release_group not in _RELEASE_GROUPS:
        raise AssistantError(f"release_group {release_group} is not recognized")
    return MetadataSuggestion(
        model_id=_require_model(body),
        operation="suggest_metadata",
        title=_require_str(body, "title"),
        keywords=_require_str_list(body, "keywords"),
        release_group=release_group,
    )


__all__ = [
    "AnalyzeImageResult",
    "AssistantError",
    "AssistantOperation",
    "AssistantTransport",
    "BrainstormResult",
    "FinalPromptResult",
    "MetadataSuggestion",
    "analyze_image",
    "brainstorm",
    "finalize_prompt",
    "suggest_metadata",
]
