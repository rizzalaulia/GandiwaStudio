"""Secure artifact retrieval and delivery boundaries."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

from fastapi import HTTPException, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

SAFE_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9_\-][A-Za-z0-9_\-\.]*$")


def build_artifact_download_response(
    file_path: Path,
    *,
    download_name: str,
    media_type: str,
    sha256: str,
    on_complete: Callable[[], None],
) -> FileResponse:
    """Return a private attachment after the durable record authorized its path."""
    if not SAFE_FILENAME_PATTERN.fullmatch(download_name) or download_name.startswith("."):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Invalid artifact record",
        )
    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")
    return FileResponse(
        path=file_path,
        media_type=media_type or "application/octet-stream",
        filename=download_name,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "X-Gandiwa-SHA256": sha256,
        },
        background=BackgroundTask(on_complete),
    )
