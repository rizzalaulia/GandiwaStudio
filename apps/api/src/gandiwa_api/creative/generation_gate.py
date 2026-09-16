"""Deterministic GENERATION_READY gate (Issue #58).

Pure, side-effect free: it never calls a provider and never writes durable
state. It only decides whether a creative session may spend fal.ai credits.

Provider/model capability is a model registry, NOT a live call: it keeps the
gate deterministic and testable without live credentials.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from gandiwa_api.creative.models import CreativeSession

FOUR_MP = 4_000_000

# Model registry: capability determined from the selected model id alone.
# Kept intentionally explicit so the gate stays deterministic and CI never
# needs a live credential.
_IMAGE_CAPABLE_MODELS = frozenset(
    {
        "fal-ai/flux/schnell",
        "fal-ai/flux/dev",
        "fal-ai/flux-realism",
        "fal-ai/imagen",
        "fal-ai/sdxl",
    }
)

_PLACEHOLDER_PATTERN = re.compile(r"<[^>]{1,80}>|\{[^}]{1,80}\}|\[\s*placeholder\s*\]")


@dataclass(frozen=True)
class GateCheck:
    """One named deterministic check and its human-readable reason."""

    name: str
    ok: bool
    reason: str


@dataclass(frozen=True)
class GateDecision:
    """Aggregate gate verdict. `ready` is True only if every check passed."""

    ready: bool
    blockers: list[str]
    checks: list[GateCheck]


def _check_prompt_present(session: CreativeSession) -> GateCheck:
    ok = bool(session.prompt.prompt_text.strip())
    return GateCheck(
        name="prompt_present",
        ok=ok,
        reason="Prompt text is non-empty." if ok else "Prompt text is empty.",
    )


def _check_negative_prompt_present(session: CreativeSession) -> GateCheck:
    ok = bool(session.prompt.negative_prompt_text.strip())
    return GateCheck(
        name="negative_prompt_present",
        ok=ok,
        reason="Negative prompt present."
        if ok
        else "Negative prompt missing; stock constraints are not enforced.",
    )


def _check_provider_model_explicit(session: CreativeSession) -> GateCheck:
    ok = bool(session.prompt.provider_id.strip()) and bool(session.prompt.model_id.strip())
    return GateCheck(
        name="provider_model_explicit",
        ok=ok,
        reason="Provider and model explicitly selected."
        if ok
        else "Provider and model must be explicitly selected before generation.",
    )


def _check_content_type_and_creation_method(session: CreativeSession) -> GateCheck:
    ok = bool(session.prompt.content_type.strip()) and bool(
        session.prompt.creation_method.strip()
    )
    return GateCheck(
        name="content_type_and_creation_method",
        ok=ok,
        reason="Content type and creation method set."
        if ok
        else "Content type and creation method must be set for provenance.",
    )


def _check_resolution_target(session: CreativeSession) -> GateCheck:
    width = session.prompt.target_width
    height = session.prompt.target_height
    ok = width > 0 and height > 0 and width * height >= FOUR_MP
    megapixels = (width * height) / FOUR_MP
    return GateCheck(
        name="resolution_target",
        ok=ok,
        reason=f"Target {width}x{height} ({megapixels:.2f} MP)."
        if ok
        else f"Target {width}x{height} is below the 4 MP floor.",
    )


def _check_aspect_ratio_and_orientation(session: CreativeSession) -> GateCheck:
    ok = bool(session.prompt.aspect_ratio.strip()) and bool(session.prompt.orientation.strip())
    return GateCheck(
        name="aspect_ratio_and_orientation",
        ok=ok,
        reason="Aspect ratio and orientation explicit."
        if ok
        else "Aspect ratio and orientation must be explicit.",
    )


def _check_stock_constraints_present(session: CreativeSession) -> GateCheck:
    constraints = session.prompt.stock_constraints
    ok = constraints is not None and bool(constraints.negative_space_decision.strip())
    return GateCheck(
        name="stock_constraints_present",
        ok=ok,
        reason="Stock constraints present with negative-space decision."
        if ok
        else "Stock constraints missing or negative-space decision unrecorded.",
    )


def _check_no_unresolved_placeholders(session: CreativeSession) -> GateCheck:
    text = session.prompt.prompt_text
    ok = not _PLACEHOLDER_PATTERN.search(text)
    return GateCheck(
        name="no_unresolved_placeholders",
        ok=ok,
        reason="No unresolved placeholders in prompt."
        if ok
        else "Prompt still contains unresolved placeholders.",
    )


def _check_capability_match(session: CreativeSession) -> GateCheck:
    model_id = session.prompt.model_id.strip()
    ok = model_id in _IMAGE_CAPABLE_MODELS
    return GateCheck(
        name="capability_match",
        ok=ok,
        reason=f"Model {model_id} is image-capable."
        if ok
        else f"Model {model_id} is not image-capable.",
    )


def evaluate_generation_readiness(session: CreativeSession) -> GateDecision:
    """Evaluate every deterministic GENERATION_READY check for one session."""
    checks = [
        _check_prompt_present(session),
        _check_negative_prompt_present(session),
        _check_provider_model_explicit(session),
        _check_content_type_and_creation_method(session),
        _check_resolution_target(session),
        _check_aspect_ratio_and_orientation(session),
        _check_stock_constraints_present(session),
        _check_no_unresolved_placeholders(session),
        _check_capability_match(session),
    ]
    blockers = [check.name for check in checks if not check.ok]
    return GateDecision(
        ready=not blockers,
        blockers=blockers,
        checks=checks,
    )


GENERATION_READY_CHECKS = (
    "prompt_present",
    "negative_prompt_present",
    "provider_model_explicit",
    "content_type_and_creation_method",
    "resolution_target",
    "aspect_ratio_and_orientation",
    "stock_constraints_present",
    "no_unresolved_placeholders",
    "capability_match",
)


__all__ = [
    "FOUR_MP",
    "GENERATION_READY_CHECKS",
    "GateCheck",
    "GateDecision",
    "evaluate_generation_readiness",
]
