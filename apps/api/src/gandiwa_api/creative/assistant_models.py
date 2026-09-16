"""Assistant result models shared across the creative session (Issue #58).

Kept separate from `assistant_adapter.py` so the session sidecar and the
adapter can both depend on the record shape without importing transport logic.
"""

from __future__ import annotations

from pydantic import BaseModel


class VisionReview(BaseModel):
    """Vision analysis record. Advisory only; it never sets a gate verdict."""

    summary: str = ""
    concerns: list[str] = []
    blocker: bool = False
    model_id: str = ""


class MetadataSuggestionRecord(BaseModel):
    """Assistant metadata suggestion; durable only after human confirmation."""

    title: str = ""
    keywords: list[str] = []
    release_group: str = ""
    model_id: str = ""
    human_confirmed: bool = False


__all__ = [
    "MetadataSuggestionRecord",
    "VisionReview",
]
