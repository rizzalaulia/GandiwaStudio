"""Secure artifact retrieval and delivery boundaries."""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path

from fastapi import HTTPException, status
from fastapi.responses import FileResponse

# Pattern for safe artifact file names (must start with alphanumeric, underscore, or dash)
SAFE_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9_\-][A-Za-z0-9_\-\.]*$")


def validate_artifact_path(filename: str, artifact_dir: Path) -> Path:
    """Validate filename against path traversal and ensure it stays within artifact directory."""
    if not filename or not isinstance(filename, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename must be a non-empty string",
        )

    if (
        "/" in filename
        or "\\" in filename
        or filename.startswith(".")
        or not SAFE_FILENAME_PATTERN.match(filename)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Invalid artifact filename: illegal characters, "
                "dotfiles, or path traversal attempted"
            ),
        )

    resolved_dir = artifact_dir.resolve()
    target_path = (resolved_dir / filename).resolve()

    if not target_path.is_relative_to(resolved_dir):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path traversal outside artifact directory is blocked",
        )

    if not target_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Artifact not found",
        )

    return target_path


def build_artifact_download_response(
    filename: str,
    artifact_dir: Path,
) -> FileResponse:
    """Build a secure FileResponse for downloading artifacts.

    Acceptance criteria:
    - Raw SVG is never served inline same-origin.
    - Authorized downloads use Content-Disposition: attachment and X-Content-Type-Options: nosniff.
    """
    file_path = validate_artifact_path(filename, artifact_dir)

    content_type, _ = mimetypes.guess_type(file_path.name)
    if not content_type:
        content_type = "application/octet-stream"

    # SVG files must explicitly use image/svg+xml and attachment disposition
    if file_path.suffix.lower() == ".svg":
        content_type = "image/svg+xml"

    headers = {
        "Content-Disposition": f'attachment; filename="{file_path.name}"',
        "X-Content-Type-Options": "nosniff",
    }

    return FileResponse(
        path=file_path,
        media_type=content_type,
        headers=headers,
    )
