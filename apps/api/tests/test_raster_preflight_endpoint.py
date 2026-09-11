"""HTTP contract tests for the ephemeral raster preflight endpoint."""

from __future__ import annotations

from collections.abc import AsyncIterator
from io import BytesIO

import httpx
import pytest
from PIL import Image

from gandiwa_api.main import app, read_limited_request_body
from gandiwa_api.security.csrf import CSRF_HEADER_NAME

pytestmark = pytest.mark.anyio


def make_jpeg() -> bytes:
    image = Image.new("RGB", (2_000, 2_000), color=(12, 34, 56))
    payload = BytesIO()
    image.save(payload, format="JPEG")
    return payload.getvalue()


async def test_limited_body_reader_keeps_only_limit_plus_one_bytes_from_large_chunk() -> None:
    async def stream() -> AsyncIterator[bytes]:
        yield b"x" * 10

    body, exceeded_limit = await read_limited_request_body(stream(), max_bytes=4)

    assert body == b"x" * 5
    assert exceeded_limit is True


async def test_raster_preflight_requires_csrf_token() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/raster/preflight?content_type=photo",
            content=make_jpeg(),
            headers={
                "Content-Type": "image/jpeg",
                "X-Upload-Filename": "stock-photo.jpeg",
            },
        )

    assert response.status_code == 403


async def test_raster_preflight_returns_only_deterministic_technical_report() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        csrf_response = await client.get("/api/v1/auth/csrf")
        token = csrf_response.json()["csrf_token"]
        response = await client.post(
            "/api/v1/raster/preflight?content_type=photo",
            content=make_jpeg(),
            headers={
                "Content-Type": "image/jpeg",
                "X-Upload-Filename": "stock-photo.jpeg",
                CSRF_HEADER_NAME: token,
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "verdict": "pass",
        "detected_mime_type": "image/jpeg",
        "detected_extension": "jpeg",
        "width": 2_000,
        "height": 2_000,
        "megapixels": 4.0,
        "has_alpha": False,
        "eligible_for_submission": True,
        "findings": [],
    }
