"""Tests for CSRF protection and session cookies boundaries."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from gandiwa_api.config import Settings
from gandiwa_api.security.csrf import (
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    CSRFProtectionMiddleware,
    generate_csrf_token,
    set_csrf_cookie,
    set_session_cookie,
    verify_csrf_token,
)

pytestmark = pytest.mark.anyio


def create_test_app(settings: Settings) -> FastAPI:
    test_app = FastAPI()
    test_app.add_middleware(CSRFProtectionMiddleware, settings=settings)

    @test_app.get("/api/v1/auth/csrf")
    def get_csrf_token() -> JSONResponse:
        token = generate_csrf_token(settings.SESSION_SECRET)
        response = JSONResponse(content={"csrf_token": token})
        set_csrf_cookie(response, token, secure=settings.SECURE_COOKIES)
        return response

    @test_app.get("/api/v1/safe-endpoint")
    def safe_endpoint() -> dict[str, str]:
        return {"status": "read"}

    @test_app.post("/api/v1/mutating-endpoint")
    def mutating_endpoint() -> dict[str, str]:
        return {"status": "created"}

    @test_app.delete("/api/v1/mutating-endpoint")
    def delete_endpoint() -> dict[str, str]:
        return {"status": "deleted"}

    return test_app


async def test_safe_get_method_succeeds_without_csrf() -> None:
    settings = Settings(SESSION_SECRET="test-secret")
    app = create_test_app(settings)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/safe-endpoint")
        assert res.status_code == 200
        assert res.json() == {"status": "read"}

        # Trailing slash test on exempt path: passes CSRF middleware without 403
        res_slash = await client.get("/api/v1/auth/csrf/")
        assert res_slash.status_code in (200, 307)


async def test_mutating_method_rejected_when_csrf_missing() -> None:
    settings = Settings(SESSION_SECRET="test-secret")
    app = create_test_app(settings)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # Neither header nor cookie
        res = await client.post("/api/v1/mutating-endpoint")
        assert res.status_code == 403
        assert "missing token" in res.json()["detail"]

        # Only header, no cookie
        token = generate_csrf_token("test-secret")
        res2 = await client.post(
            "/api/v1/mutating-endpoint",
            headers={CSRF_HEADER_NAME: token},
        )
        assert res2.status_code == 403

        # Only cookie, no header
        res3 = await client.post(
            "/api/v1/mutating-endpoint",
            headers={"Cookie": f"{CSRF_COOKIE_NAME}={token}"},
        )
        assert res3.status_code == 403


async def test_mutating_method_rejected_when_token_mismatched() -> None:
    settings = Settings(SESSION_SECRET="test-secret")
    app = create_test_app(settings)
    token1 = generate_csrf_token("test-secret")
    token2 = generate_csrf_token("test-secret")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/mutating-endpoint",
            headers={
                CSRF_HEADER_NAME: token1,
                "Cookie": f"{CSRF_COOKIE_NAME}={token2}",
            },
        )
        assert res.status_code == 403
        assert "do not match" in res.json()["detail"]


async def test_mutating_method_rejected_when_signature_invalid() -> None:
    settings = Settings(SESSION_SECRET="test-secret")
    app = create_test_app(settings)
    # Token generated with different secret
    forged_token = generate_csrf_token("attacker-secret")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/mutating-endpoint",
            headers={
                CSRF_HEADER_NAME: forged_token,
                "Cookie": f"{CSRF_COOKIE_NAME}={forged_token}",
            },
        )
        assert res.status_code == 403
        assert "invalid token signature" in res.json()["detail"]


async def test_mutating_method_succeeds_with_valid_csrf() -> None:
    settings = Settings(SESSION_SECRET="test-secret")
    app = create_test_app(settings)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # Initialize token via endpoint
        csrf_init = await client.get("/api/v1/auth/csrf")
        assert csrf_init.status_code == 200
        token = csrf_init.json()["csrf_token"]
        assert CSRF_COOKIE_NAME in csrf_init.cookies

        # Perform POST with matching header and cookie
        post_res = await client.post(
            "/api/v1/mutating-endpoint",
            headers={
                CSRF_HEADER_NAME: token,
                "Cookie": f"{CSRF_COOKIE_NAME}={token}",
            },
        )
        assert post_res.status_code == 200
        assert post_res.json() == {"status": "created"}

        # Perform DELETE with matching header and cookie
        delete_res = await client.delete(
            "/api/v1/mutating-endpoint",
            headers={
                CSRF_HEADER_NAME: token,
                "Cookie": f"{CSRF_COOKIE_NAME}={token}",
            },
        )
        assert delete_res.status_code == 200
        assert delete_res.json() == {"status": "deleted"}


def test_session_and_csrf_cookie_attributes() -> None:
    response = JSONResponse(content={"status": "ok"})
    set_session_cookie(response, "sess-12345", secret="test-session-secret", secure=True)
    set_csrf_cookie(response, "csrf-abcde", secure=True)

    session_cookie_header = next(
        val.decode("utf-8")
        for key, val in response.raw_headers
        if key.lower() == b"set-cookie" and b"gandiwa_session=" in val
    )

    csrf_cookie_header = next(
        val.decode("utf-8")
        for key, val in response.raw_headers
        if key.lower() == b"set-cookie" and b"gandiwa_csrf=" in val
    )

    # Session cookie must be HttpOnly and Secure
    assert "HttpOnly" in session_cookie_header
    assert "Secure" in session_cookie_header
    assert "SameSite=lax" in session_cookie_header

    # CSRF cookie must NOT be HttpOnly (client script needs it) and must be Secure
    assert "HttpOnly" not in csrf_cookie_header
    assert "Secure" in csrf_cookie_header
    assert "SameSite=lax" in csrf_cookie_header


def test_verify_csrf_token_edge_cases() -> None:
    assert not verify_csrf_token("", "secret")
    assert not verify_csrf_token("invalid-format", "secret")
    assert not verify_csrf_token("a.b.c", "secret")
