"""Creative session contracts (Issue #58).

The creative session is a project-local versioned sidecar living OUTSIDE
manifest v1. Manifest v1 stays untouched; these models exist only to give the
assistant adapter and the deterministic gate a strict runtime shape.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from gandiwa_api.creative.assistant_models import VisionReview


class StockConstraints(BaseModel):
    """Stock-readiness constraints carried into the prompt (all non-negotiable)."""

    no_logo: bool = False
    no_brand: bool = False
    no_watermark: bool = False
    no_random_text: bool = False
    no_fake_ui: bool = False
    no_unintentional_crop: bool = False
    no_malformed_anatomy: bool = False
    no_copyrighted_property: bool = False
    negative_space_decision: str = ""


class PromptSnapshot(BaseModel):
    """Prompt state before any fal.ai call; the dispatched snapshot is immutable."""

    prompt_text: str = ""
    negative_prompt_text: str = ""
    content_type: str = ""
    creation_method: str = ""
    provider_id: str = ""
    model_id: str = ""
    target_width: int = 0
    target_height: int = 0
    aspect_ratio: str = ""
    orientation: str = ""
    stock_constraints: StockConstraints | None = None


class GenerationProvenance(BaseModel):
    """What the provider actually ran; bound to exactly one revision."""

    provider_id: str
    model_id: str
    provider_job_id: str
    seed: int | None = None
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)
    adapter_version: str
    created_at: str = ""


class DispatchedPrompt(BaseModel):
    """Immutable prompt snapshot plus its generation provenance."""

    id: str
    prompt_text: str
    negative_prompt_text: str
    content_type: str
    creation_method: str
    provider_id: str
    model_id: str
    target_width: int
    target_height: int
    aspect_ratio: str
    orientation: str
    stock_constraints: StockConstraints | None = None
    provenance: GenerationProvenance | None = None
    vision_review: VisionReview | None = None
    rejection_reason: str | None = None


class CreativeApproval(BaseModel):
    """Human approval evidence for one creative decision."""

    stage: str
    human: str
    approved_at: str
    prompt_digest: str | None = None


class CreativeSession(BaseModel):
    """Top-level creative session sidecar (brainstorming through approvals)."""

    topic: str
    prompt: PromptSnapshot = Field(default_factory=PromptSnapshot)
    approved_concept: str | None = None
    human_prompt_approval: bool = False
    # SHA-256 of the exact prompt snapshot accepted by the human.
    approved_prompt_digest: str | None = None
    creative_approvals: list[CreativeApproval] = Field(default_factory=list)
    # A regenerate reason belongs to a draft until provider success creates its revision.
    pending_rejection_reason: str | None = None
    dispatched: bool = False
    # Digest of the prompt snapshot most recently submitted to a provider.
    last_dispatched_prompt_digest: str | None = None
    revisions: list[DispatchedPrompt] = Field(default_factory=list)


__all__ = [
    "CreativeSession",
    "DispatchedPrompt",
    "GenerationProvenance",
    "PromptSnapshot",
    "StockConstraints",
]
