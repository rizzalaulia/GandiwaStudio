"""FastAPI main application entrypoint."""

import sqlite3
from typing import Any

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse

from gandiwa_api.config import Settings

app = FastAPI(title="Gandiwa Studio API")


@app.get("/api/v1/health")
def get_health() -> dict[str, str]:
    current_settings = Settings()
    return {
        "status": "ok",
        "version": current_settings.VERSION,
    }


@app.get("/api/v1/ready")
def get_ready() -> JSONResponse:
    current_settings = Settings()
    checks: dict[str, bool] = {
        "database": False,
        "artifacts_dir": False,
    }

    # 1. Check Artifact Directory existence & writability
    artifact_path = current_settings.ARTIFACT_DIR
    if artifact_path.exists() and artifact_path.is_dir():
        checks["artifacts_dir"] = True

    # 2. Check Database connectivity
    db_path = current_settings.DATABASE_PATH
    try:
        # Connect with short timeout
        conn = sqlite3.connect(str(db_path), timeout=2.0)
        conn.execute("SELECT 1;")
        conn.close()
        checks["database"] = True
    except Exception:
        checks["database"] = False

    all_ready = all(checks.values())
    status_code = status.HTTP_200_OK if all_ready else status.HTTP_503_SERVICE_UNAVAILABLE

    response_data: dict[str, Any] = {
        "status": "ready" if all_ready else "unavailable",
        "checks": checks,
    }
    return JSONResponse(status_code=status_code, content=response_data)
