"""Tests for /api/v1/health and /api/v1/ready endpoints."""

import pytest
from fastapi.testclient import TestClient

from gandiwa_api.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_health_endpoint_returns_ok(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


def test_health_endpoint_does_not_expose_secrets_or_paths(client):
    response = client.get("/api/v1/health")
    data = response.json()
    for key in ("secret", "token", "key", "password", "path", "database_url"):
        assert key not in data


def test_readiness_endpoint_healthy(client, tmp_path, monkeypatch):
    test_db = tmp_path / "test.db"
    test_artifacts = tmp_path / "artifacts"
    test_artifacts.mkdir()

    monkeypatch.setenv("GANDIWA_DATABASE_PATH", str(test_db))
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(test_artifacts))

    response = client.get("/api/v1/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert data["checks"]["database"] is True
    assert data["checks"]["artifacts_dir"] is True
    # Ensure sensitive paths are omitted
    for _, v in data.items():
        assert str(test_db) not in str(v)
        assert str(test_artifacts) not in str(v)


def test_readiness_endpoint_fails_when_artifacts_dir_missing(client, tmp_path, monkeypatch):
    test_db = tmp_path / "test.db"
    non_existent_artifacts = tmp_path / "does_not_exist"

    monkeypatch.setenv("GANDIWA_DATABASE_PATH", str(test_db))
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(non_existent_artifacts))

    response = client.get("/api/v1/ready")
    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "unavailable"
    assert data["checks"]["artifacts_dir"] is False
