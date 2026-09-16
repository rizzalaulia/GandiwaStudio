"""Creative session sidecar service (Issue #58).

Project-local, versioned, OUTSIDE manifest v1. The session records the creative
laku: topic, prompt, dispatch, generation provenance, vision review, approvals.

Two rules are enforced here:

1. Once a prompt snapshot has been dispatched it is immutable. Editing the
   prompt after dispatch is refused. Only `regenerate` may add a new revision,
   and it never overwrites the previous one.
2. Regenerate requires a meaningful prompt change or a recorded rejection
   reason. An identical re-dispatch is refused before fal.ai credits are spent.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from gandiwa_api.creative.assistant_models import VisionReview
from gandiwa_api.creative.models import (
    CreativeSession,
    DispatchedPrompt,
    GenerationProvenance,
    PromptSnapshot,
    StockConstraints,
)


class PromptSnapshotFrozen(RuntimeError):
    """Raised when a dispatched prompt snapshot would be mutated."""


def start_session(topic: str) -> CreativeSession:
    """Open a new creative session sidecar for one topic."""
    return CreativeSession(topic=topic)


def import_prompt_from_assistant(
    session: CreativeSession,
    *,
    prompt_text: str,
    negative_prompt_text: str,
    content_type: str,
    creation_method: str,
    provider_id: str,
    model_id: str,
    target_width: int,
    target_height: int,
    aspect_ratio: str,
    orientation: str,
    stock_constraints: StockConstraints | None = None,
) -> CreativeSession:
    """Replace the working prompt with the assistant-authored draft."""
    if session.dispatched:
        raise PromptSnapshotFrozen("prompt snapshot is immutable after dispatch")
    session.prompt = PromptSnapshot(
        prompt_text=prompt_text,
        negative_prompt_text=negative_prompt_text,
        content_type=content_type,
        creation_method=creation_method,
        provider_id=provider_id,
        model_id=model_id,
        target_width=target_width,
        target_height=target_height,
        aspect_ratio=aspect_ratio,
        orientation=orientation,
        stock_constraints=stock_constraints,
    )
    return session


def _snapshot_prompt(session: CreativeSession) -> DispatchedPrompt:
    prompt = session.prompt
    return DispatchedPrompt(
        id=str(uuid.uuid4()),
        prompt_text=prompt.prompt_text,
        negative_prompt_text=prompt.negative_prompt_text,
        content_type=prompt.content_type,
        creation_method=prompt.creation_method,
        provider_id=prompt.provider_id,
        model_id=prompt.model_id,
        target_width=prompt.target_width,
        target_height=prompt.target_height,
        aspect_ratio=prompt.aspect_ratio,
        orientation=prompt.orientation,
        stock_constraints=prompt.stock_constraints,
    )


def record_generation_provenance(
    session: CreativeSession,
    *,
    provider_job_id: str,
    seed: int | None = None,
    parameters: dict[str, str | int | float | bool] | None = None,
    adapter_version: str = "",
    model_id: str = "",
) -> None:
    """Bind provider execution facts to the most recent dispatched revision."""
    revision = _require_current_revision(session)
    if revision.provenance is not None:
        raise PromptSnapshotFrozen("revision already has provenance")
    revision.provenance = GenerationProvenance(
        provider_id=revision.provider_id,
        model_id=model_id or revision.model_id,
        provider_job_id=provider_job_id,
        seed=seed,
        parameters=parameters or {},
        adapter_version=adapter_version,
        created_at=datetime.now(UTC).isoformat(),
    )


def record_vision_review(
    session: CreativeSession,
    *,
    summary: str,
    concerns: list[str],
    blocker: bool,
    model_id: str = "",
) -> VisionReview:
    """Attach an advisory vision review. It never sets a gate or audit verdict."""
    review = VisionReview(
        summary=summary,
        concerns=concerns,
        blocker=blocker,
        model_id=model_id,
    )
    revision = _require_current_revision(session)
    revision.vision_review = review
    return review


def _require_current_revision(session: CreativeSession) -> DispatchedPrompt:
    if not session.revisions:
        raise PromptSnapshotFrozen("no dispatched revision exists yet")
    return session.revisions[-1]


class SessionService:
    """Mutable session handle with snapshot-immutability and regenerate rules."""

    def __init__(self, session: CreativeSession) -> None:
        self._session = session

    @property
    def session(self) -> CreativeSession:
        return self._session

    @property
    def dispatched(self) -> bool:
        return self._session.dispatched

    @property
    def revisions(self) -> list[DispatchedPrompt]:
        return self._session.revisions

    @property
    def current_revision(self) -> DispatchedPrompt | None:
        return self._session.revisions[-1] if self._session.revisions else None

    def import_prompt(self, prompt: PromptSnapshot) -> None:
        if self._session.dispatched:
            raise PromptSnapshotFrozen("prompt snapshot is immutable after dispatch")
        self._session.prompt = prompt

    def replace_prompt_text(self, text: str) -> None:
        if self._session.dispatched:
            raise PromptSnapshotFrozen("prompt snapshot is immutable after dispatch")
        self._session.prompt.prompt_text = text

    def _freeze_initial_revision(self) -> DispatchedPrompt:
        """Internal policy finalizer for the first successfully dispatched prompt."""
        if self._session.dispatched:
            raise PromptSnapshotFrozen(
                "prompt is already dispatched; use regenerate with a change or rejection reason"
            )
        revision = _snapshot_prompt(self._session)
        self._session.revisions.append(revision)
        self._session.dispatched = True
        return revision

    def finalize_pending_regeneration(self) -> DispatchedPrompt:
        """Freeze the approved regenerate draft only after provider success."""
        if self._session.pending_rejection_reason is None and (
            self.current_revision is None
            or self._session.prompt.prompt_text == self.current_revision.prompt_text
        ):
            raise PromptSnapshotFrozen("no pending regenerate draft exists")
        revision = _snapshot_prompt(self._session)
        revision.rejection_reason = self._session.pending_rejection_reason
        self._session.revisions.append(revision)
        self._session.pending_rejection_reason = None
        return revision

    def regenerate(
        self,
        *,
        new_prompt_text: str,
        rejection_reason: str | None = None,
    ) -> DispatchedPrompt:
        """Add a new revision. The previous snapshot stays untouched."""
        if self.current_revision is None:
            raise PromptSnapshotFrozen("no previous dispatch to regenerate from")
        assert self.current_revision is not None  # for the type checker
        if (
            new_prompt_text.strip() == self.current_revision.prompt_text.strip()
            and not rejection_reason
        ):
            raise ValueError(
                "regenerate requires a meaningful change or a recorded rejection reason"
            )
        self._session.prompt = PromptSnapshot(
            prompt_text=new_prompt_text,
            negative_prompt_text=self.current_revision.negative_prompt_text,
            content_type=self.current_revision.content_type,
            creation_method=self.current_revision.creation_method,
            provider_id=self.current_revision.provider_id,
            model_id=self.current_revision.model_id,
            target_width=self.current_revision.target_width,
            target_height=self.current_revision.target_height,
            aspect_ratio=self.current_revision.aspect_ratio,
            orientation=self.current_revision.orientation,
            stock_constraints=self.current_revision.stock_constraints,
        )
        # A regenerate draft always needs new human approval, even if it uses
        # an identical prompt with a recorded rejection reason.
        self._session.human_prompt_approval = False
        self._session.approved_prompt_digest = None
        self._session.pending_rejection_reason = rejection_reason
        return _snapshot_prompt(self._session)


__all__ = [
    "PromptSnapshotFrozen",
    "SessionService",
    "import_prompt_from_assistant",
    "record_generation_provenance",
    "record_vision_review",
    "start_session",
]
