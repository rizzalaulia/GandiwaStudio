"""Fail-closed generation dispatch policy (Issue #58 contract integration).

This module owns no provider credential and persists no project data. The
browser owns the creative-session sidecar. A selected provider is passed via an
injected transport only after the deterministic gate and exact human prompt
approval have passed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from gandiwa_api.creative.approval import current_prompt_digest
from gandiwa_api.creative.generation_gate import evaluate_generation_readiness
from gandiwa_api.creative.models import CreativeSession
from gandiwa_api.creative.session import SessionService, record_generation_provenance
from gandiwa_api.queue import QueueStore

# Current production registry. A future connector must deliberately inject a
# provider → model mapping; independent allowlists would permit unsafe cross-
# provider/model combinations.
CURRENT_IMAGE_GENERATION_PROVIDER_MODELS: dict[str, frozenset[str]] = {
    "fal": frozenset(
        {
            "fal-ai/flux/schnell",
            "fal-ai/flux/dev",
            "fal-ai/flux-realism",
            "fal-ai/imagen",
            "fal-ai/sdxl",
        }
    )
}

# Backwards-compatible alias: approval.py is the single digest authority.
prompt_snapshot_digest = current_prompt_digest


class GenerationDispatchError(RuntimeError):
    """A generation request was rejected before trustworthy completion."""


def enqueue_approved_generation(
    queue: QueueStore,
    session: CreativeSession,
    *,
    owner_session_id: str,
    rules_snapshot: dict[str, object],
    idempotency_key: str,
    origin: str,
    provider_models: dict[str, set[str] | frozenset[str]] | None = None,
) -> str:
    """Freeze one approved prompt and its rules into a durable fal job."""
    registry = (
        CURRENT_IMAGE_GENERATION_PROVIDER_MODELS
        if provider_models is None
        else {provider: frozenset(models) for provider, models in provider_models.items()}
    )
    models = registry.get(session.prompt.provider_id)
    if models is None or session.prompt.model_id not in models:
        raise GenerationDispatchError("image generation provider/model is not registered")
    gate = evaluate_generation_readiness(session, image_capable_models=models)
    if not gate.ready:
        raise GenerationDispatchError(f"GENERATION_READY is blocked: {', '.join(gate.blockers)}")
    digest = prompt_snapshot_digest(session)
    if not session.human_prompt_approval or session.approved_prompt_digest != digest:
        raise GenerationDispatchError("exact prompt snapshot requires human approval")
    if session.last_dispatched_prompt_digest == digest:
        raise GenerationDispatchError("approved prompt was already submitted to the provider")
    if (
        not owner_session_id
        or not idempotency_key
        or origin.rstrip("/") != "https://queue.fal.run"
        or not rules_snapshot
    ):
        raise GenerationDispatchError("generation job identity and rules snapshot are required")
    prompt = session.prompt
    job_id = queue.enqueue(
        job_type="generate",
        provider_id=prompt.provider_id,
        model_id=prompt.model_id,
        parameters={
            "origin": origin,
            "idempotency_key": idempotency_key,
            "capability": "generate_image",
            "owner_session_id": owner_session_id,
            "approved_prompt_digest": digest,
            "rules_snapshot": dict(rules_snapshot),
            "generation_payload": {
                "prompt": prompt.prompt_text,
                "negative_prompt": prompt.negative_prompt_text,
                "image_size": {
                    "width": prompt.target_width,
                    "height": prompt.target_height,
                },
                "num_images": 1,
            },
        },
    )
    session.last_dispatched_prompt_digest = digest
    return job_id


class GenerationTransport(Protocol):
    """Provider-neutral transport; concrete connectors belong to #25."""

    def submit(self, payload: dict[str, object]) -> dict[str, object]:
        """Submit a prepared request to an explicitly selected image provider."""
        ...


@dataclass(frozen=True)
class GenerationRequest:
    """Provider result safe to add to generation provenance."""

    provider_job_id: str
    seed: int | None


def dispatch_generation(
    session: CreativeSession,
    transport: GenerationTransport,
    *,
    provider_models: dict[str, set[str] | frozenset[str]] | None = None,
) -> GenerationRequest:
    """Dispatch only an approved registered provider/model pair; fail closed."""
    registry = (
        CURRENT_IMAGE_GENERATION_PROVIDER_MODELS
        if provider_models is None
        else {provider: frozenset(models) for provider, models in provider_models.items()}
    )
    models = registry.get(session.prompt.provider_id)
    if models is None or session.prompt.model_id not in models:
        raise GenerationDispatchError("image generation provider/model is not registered")
    gate = evaluate_generation_readiness(
        session,
        image_capable_models=models,
    )
    if not gate.ready:
        raise GenerationDispatchError(f"GENERATION_READY is blocked: {', '.join(gate.blockers)}")
    if not session.human_prompt_approval:
        raise GenerationDispatchError("exact prompt snapshot requires human approval")
    if session.approved_prompt_digest != prompt_snapshot_digest(session):
        raise GenerationDispatchError("exact prompt snapshot is not the human-approved snapshot")
    if session.last_dispatched_prompt_digest == prompt_snapshot_digest(session):
        raise GenerationDispatchError("approved prompt was already submitted to the provider")

    prompt = session.prompt
    payload: dict[str, object] = {
        "prompt": prompt.prompt_text,
        "negative_prompt": prompt.negative_prompt_text,
        "provider": prompt.provider_id,
        "model": prompt.model_id,
        "width": prompt.target_width,
        "height": prompt.target_height,
        "aspect_ratio": prompt.aspect_ratio,
    }
    try:
        response = transport.submit(payload)
    except TimeoutError as error:
        raise GenerationDispatchError("generation provider unreachable") from error
    except Exception as error:
        raise GenerationDispatchError("generation provider request failed") from error

    job_id = response.get("provider_job_id")
    seed = response.get("seed")
    if not isinstance(job_id, str) or not job_id:
        raise GenerationDispatchError("invalid generation response")
    if seed is not None and not isinstance(seed, int):
        raise GenerationDispatchError("invalid generation response")
    _remember_dispatched_prompt_digest(session)
    return GenerationRequest(provider_job_id=job_id, seed=seed)


def _remember_dispatched_prompt_digest(session: CreativeSession) -> None:
    session.last_dispatched_prompt_digest = prompt_snapshot_digest(session)


def dispatch_and_record_generation(
    service: SessionService,
    transport: GenerationTransport,
    *,
    adapter_version: str = "creative-dispatch-policy/1",
    provider_models: dict[str, set[str] | frozenset[str]] | None = None,
) -> GenerationRequest:
    """Dispatch and bind the provider job to the pending immutable revision.

    Initial dispatch freezes a revision only after the provider returns. A
    prior explicit ``regenerate`` already creates its new revision; it may be
    submitted once while provenance is still absent. Any completed revision is
    refused before provider I/O, so an accidental retry cannot spend credits.
    """
    current = service.current_revision
    has_pending_regeneration = current is not None and (
        service.session.pending_rejection_reason is not None
        or service.session.prompt.prompt_text != current.prompt_text
    )
    if current is not None and current.provenance is not None and not has_pending_regeneration:
        raise GenerationDispatchError("current revision was already dispatched")
    request = dispatch_generation(
        service.session,
        transport,
        provider_models=provider_models,
    )
    service.session.last_dispatched_prompt_digest = prompt_snapshot_digest(service.session)
    if current is None:
        service._freeze_initial_revision()
    elif has_pending_regeneration:
        service.finalize_pending_regeneration()
    record_generation_provenance(
        service.session,
        provider_job_id=request.provider_job_id,
        seed=request.seed,
        adapter_version=adapter_version,
    )
    return request


__all__ = [
    "GenerationDispatchError",
    "GenerationRequest",
    "GenerationTransport",
    "dispatch_and_record_generation",
    "dispatch_generation",
    "enqueue_approved_generation",
    "prompt_snapshot_digest",
]
