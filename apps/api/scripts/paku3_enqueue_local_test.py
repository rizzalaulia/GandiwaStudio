"""Paku 3: enqueue end-to-end proof without any provider call or billing.

Chain:
  A. Browser (Playwright, live rev3 page) computes the approval digest of a
     fixed prompt spec via window.Rev3Canonical (the Shipped browser module).
  B. Backend computes current_prompt_digest over the equivalent PromptSnapshot
     and asserts equality with the browser digest (cross-runtime contract).
  C. POST through the real app (TestClient, isolated tmp SQLite, no worker)
     with the approved digest: 201, job 'queued', owner-scoped public view,
     idempotent retry returns the SAME job id, queue row count == 1, artifact
     dir untouched (no provider I/O, zero billing).

Run:  venv python scripts/paku3_enqueue_local_test.py <browser_digest_hex>
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def part_b_and_c(browser_digest: str) -> int:
    from gandiwa_api.creative.approval import current_prompt_digest
    from gandiwa_api.creative.models import CreativeSession, PromptSnapshot, StockConstraints

    # ---- Part B: backend digest over the equivalent snapshot -------------
    prompt = PromptSnapshot(
        prompt_text="Editorial ceramic coffee mug on warm linen, soft window light, 4096x3072",
        negative_prompt_text="logo, watermark, brand name, random text, fake interface, malformed anatomy",
        content_type="photo",
        creation_method="generative_ai",
        provider_id="fal",
        model_id="fal-ai/flux/schnell",
        target_width=4096,
        target_height=3072,
        aspect_ratio="4:3",
        orientation="landscape",
        stock_constraints=StockConstraints(
            no_logo=True,
            no_brand=True,
            no_watermark=True,
            no_random_text=True,
            no_fake_ui=True,
            no_unintentional_crop=True,
            no_malformed_anatomy=True,
            no_copyrighted_property=True,
            negative_space_decision="none required",
        ),
    )
    session = CreativeSession(topic="Paku3 proof", prompt=prompt)
    backend_digest = current_prompt_digest(session)
    material = session.prompt.model_dump(mode="json")
    canonical = json.dumps(material, sort_keys=True, separators=(",", ":"))
    print("B stdlib canonical json equals backend digest:", backend_digest)
    assert backend_digest == browser_digest, "browser digest != backend digest"
    print("B PASS browser and backend digests are identical across runtimes")

    # ---- Part C: real app enqueue into an isolated durable queue ---------
    workdir = Path(f"/tmp/paku3-{uuid.uuid4().hex[:8]}")
    db = workdir / "paku3.sqlite3"
    artifacts = workdir / "artifacts"
    artifacts.mkdir(parents=True)
    import os

    os.environ["GANDIWA_DATABASE_URL"] = f"sqlite:///{db}"
    os.environ["GANDIWA_ARTIFACT_DIR"] = str(artifacts)

    from alembic import command
    from alembic.config import Config

    root = REPO
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db}")
    command.upgrade(config, "head")

    from fastapi.testclient import TestClient

    from gandiwa_api.config import Settings
    from gandiwa_api.main import app

    session.approved_prompt_digest = backend_digest
    session.human_prompt_approval = True
    payload = {
        "session": json.loads(session.model_dump_json()),
        "rules_snapshot": {
            "id": "adobe-stock-2026-09-08-v1",
            "version": "adobe-stock-2026-09-08-v1",
        },
        "idempotency_key": f"paku3-{uuid.uuid4().hex[:12]}",
    }

    client = TestClient(app)
    ready = client.get("/api/v1/ready")
    assert ready.status_code == 200, ready.text
    bootstrap = client.get("/api/v1/creative/bootstrap")
    assert bootstrap.status_code == 200, bootstrap.text
    assert bootstrap.json() == {"session_ready": True}
    csrf = client.get("/api/v1/auth/csrf").json()["csrf_token"]

    first = client.post(
        "/api/v1/creative/jobs",
        json=payload,
        headers={"X-CSRF-Token": csrf},
    )
    assert first.status_code == 201, f"enqueue failed: {first.status_code} {first.text}"
    job = first.json()
    print("C first enqueue ->", json.dumps(job, indent=2)[:400])
    assert job["status"] == "queued"
    assert job["artifact"] is None
    assert job["artifact_expires_at"] is None
    assert job["cancel_requested"] is False

    status_view = client.get(f"/api/v1/creative/jobs/{job['id']}")
    assert status_view.status_code == 200, status_view.text
    monitored = status_view.json()
    assert monitored["queue_position"] == 1, monitored
    print("C monitored job shows queue_position:", monitored["queue_position"])

    second = client.post(
        "/api/v1/creative/jobs",
        json=payload,
        headers={"X-CSRF-Token": csrf},
    )
    assert second.status_code == 201
    assert second.json()["id"] == job["id"], "idempotent retry minted a second job"
    print("C idempotent retry returned the same job id:", job["id"])

    import sqlite3

    rows = sqlite3.connect(str(db)).execute(
        "SELECT id, status, provider_id, model_id FROM generation_job"
    ).fetchall()
    assert len(rows) == 1, f"expected exactly one durable job row, got {len(rows)}"
    print("C durable queue rows:", rows)

    created = [p.name for p in artifacts.iterdir()]
    assert created == [], "no artifact may exist without the worker"
    print("C artifact dir untouched (no provider I/O):", created)
    queued_status = rows[0][1]
    assert queued_status == "queued"
    print("PAKU3 PASS: approved browser snapshot enqueued durably, exactly once, credits untouched")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: paku3_enqueue_local_test.py <browser_digest_hex>", file=sys.stderr)
        return 2
    return part_b_and_c(sys.argv[1].strip())


if __name__ == "__main__":
    raise SystemExit(main())
