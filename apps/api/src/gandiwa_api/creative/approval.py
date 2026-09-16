"""Human creative approval evidence (Issue #58)."""

from __future__ import annotations

import hashlib
import json

from gandiwa_api.creative.models import CreativeApproval, CreativeSession


def current_prompt_digest(session: CreativeSession) -> str:
    """Digest every field that may alter the generation request."""
    # Include the complete model dump, including nested stock constraints.  An
    # approved prompt is a full generation contract, not merely the text/API
    # parameters that the current connector happens to serialize.
    material = session.prompt.model_dump(mode="json")
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def approve_exact_prompt(
    session: CreativeSession,
    *,
    human: str,
    approved_at: str,
) -> CreativeApproval:
    """Record a human approval bound to exactly the current prompt snapshot."""
    if not human.strip() or not approved_at.strip():
        raise ValueError("human and approval timestamp are required")
    digest = current_prompt_digest(session)
    record = CreativeApproval(
        stage="prompt",
        human=human,
        approved_at=approved_at,
        prompt_digest=digest,
    )
    session.human_prompt_approval = True
    session.approved_prompt_digest = digest
    session.creative_approvals.append(record)
    return record


__all__ = ["CreativeApproval", "approve_exact_prompt", "current_prompt_digest"]
