"""OpenAI queue integration contracts, without live provider calls."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.creative.dispatch_policy import enqueue_approved_generation, prompt_snapshot_digest
from gandiwa_api.creative.models import CreativeSession, PromptSnapshot, StockConstraints
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import QueueStore


def _alembic_config(database_url: str) -> Config:
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def valid_openai_session() -> CreativeSession:
    session = CreativeSession(
        topic="ceramic mug",
        human_prompt_approval=True,
        prompt=PromptSnapshot(
            prompt_text="Editorial ceramic mug on linen, 2048x2048 output",
            negative_prompt_text="logo, brand, watermark, random text",
            content_type="raster",
            creation_method="generative_ai",
            provider_id="openai",
            model_id="gpt-image-2.5-sunburst",
            target_width=2048,
            target_height=2048,
            aspect_ratio="1:1",
            orientation="square",
            stock_constraints=StockConstraints(
                no_logo=True,
                no_brand=True,
                no_watermark=True,
                no_random_text=True,
                no_fake_ui=True,
                no_unintentional_crop=True,
                no_malformed_anatomy=True,
                no_copyrighted_property=True,
                negative_space_decision="right third open",
            ),
        ),
    )
    session.approved_prompt_digest = prompt_snapshot_digest(session)
    return session


def test_enqueue_openai_generation_freezes_its_own_origin_and_never_fal_origin(
    tmp_path: Path,
) -> None:
    runtime = Settings(DATABASE_URL=f"sqlite:///{tmp_path / 'queue.sqlite3'}")
    command.upgrade(_alembic_config(runtime.DATABASE_URL), "head")
    queue = QueueStore(create_sqlite_engine(runtime))

    job_id = enqueue_approved_generation(
        queue,
        valid_openai_session(),
        owner_session_id="session-a",
        rules_snapshot={"id": "adobe-stock", "version": "2026-09-15"},
        idempotency_key="openai-job-idem-001",
        origin="https://api.openai.com/v1",
    )

    job = queue.get(job_id)
    assert job.provider_id == "openai"
    assert job.model_id == "gpt-image-2.5-sunburst"
    assert job.parameters["origin"] == "https://api.openai.com/v1"
    assert job.parameters["capability"] == "generate_image"
