"""Tests for artifact boundary, download isolation, and SVG safety."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from gandiwa_api.security.artifacts import (
    build_artifact_download_response,
    validate_artifact_path,
)

pytestmark = pytest.mark.anyio


def create_artifact_test_app(artifact_dir: Path) -> FastAPI:
    app = FastAPI()

    @app.get("/api/v1/artifacts/{filename}/download")
    def download_artifact(filename: str) -> FileResponse:
        return build_artifact_download_response(filename, artifact_dir)

    return app


async def test_download_svg_uses_attachment_and_nosniff(tmp_path: Path) -> None:
    svg_file = tmp_path / "illustration.svg"
    svg_content = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5"/></svg>'
    svg_file.write_text(svg_content, encoding="utf-8")

    app = create_artifact_test_app(tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/artifacts/illustration.svg/download")

        assert response.status_code == 200
        assert response.text == svg_content

        # Strict headers checking
        content_disposition = response.headers.get("content-disposition", "")
        assert content_disposition.startswith("attachment;")
        assert 'filename="illustration.svg"' in content_disposition
        assert "inline" not in content_disposition.lower()

        assert response.headers.get("x-content-type-options") == "nosniff"
        assert response.headers.get("content-type", "").startswith("image/svg+xml")


async def test_download_png_uses_attachment_and_nosniff(tmp_path: Path) -> None:
    png_file = tmp_path / "sample.png"
    png_file.write_bytes(b"\x89PNG\r\n\x1a\nfake-png-data")

    app = create_artifact_test_app(tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/artifacts/sample.png/download")

        assert response.status_code == 200
        assert response.headers.get("content-disposition", "").startswith("attachment;")
        assert response.headers.get("x-content-type-options") == "nosniff"
        assert "image/png" in response.headers.get("content-type", "")


def test_path_traversal_and_dotfiles_are_blocked(tmp_path: Path) -> None:
    for malicious_name in (
        "../secret.txt",
        "..\\secret.txt",
        "..%2Fsecret.txt",
        "sub/file.svg",
        "nested/../test.svg",
        "evil/payload.svg",
        ".env",
        ".secret",
        "..",
        ".gandiwa-readiness-probe",
    ):
        with pytest.raises(HTTPException) as exc_info:
            validate_artifact_path(malicious_name, tmp_path)
        assert exc_info.value.status_code == 400
        detail = exc_info.value.detail.lower()
        assert "illegal characters" in detail or "traversal" in detail or "dotfiles" in detail


async def test_non_existent_artifact_returns_404(tmp_path: Path) -> None:
    app = create_artifact_test_app(tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/artifacts/missing-file.svg/download")
        assert response.status_code == 404
