"""SQLAlchemy 2 declarative models for durable backend state."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base metadata for Alembic and ORM mappings."""


class GenerationJob(Base):
    """Durable queue record; claiming and state transitions belong to the worker."""

    __tablename__ = "generation_job"
    __table_args__ = (
        CheckConstraint("priority >= 0", name="ck_generation_job_priority_nonnegative"),
        CheckConstraint(
            "attempt_count >= 0",
            name="ck_generation_job_attempt_count_nonnegative",
        ),
        Index("ix_generation_job_claim", "status", "priority", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    job_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    priority: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    provider_id: Mapped[str | None] = mapped_column(String(36))
    model_id: Mapped[str | None] = mapped_column(String(36))
    ruleset_snapshot_id: Mapped[str | None] = mapped_column(String(36))
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    remote_job_id: Mapped[str | None] = mapped_column(String(255))
    lease_owner: Mapped[str | None] = mapped_column(String(255))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(64))
    redacted_error: Mapped[str | None] = mapped_column(Text)
    result_manifest: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class WorkerState(Base):
    """Singleton row tracking the worker process heartbeat."""

    __tablename__ = "worker_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(32), default="idle", server_default="idle")
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CreativeIndex(Base):
    """Disposable manifest-derived rows; never a source for runtime recovery."""

    __tablename__ = "creative_index"
    __table_args__ = (
        Index("ix_creative_index_project", "project_id"),
        UniqueConstraint(
            "project_id",
            "asset_id",
            "revision",
            name="uq_creative_index_project_asset_revision",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False)
    asset_id: Mapped[str] = mapped_column(String(36), nullable=False)
    content_type: Mapped[str] = mapped_column(String(16), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    relative_path: Mapped[str] = mapped_column(String(1024), nullable=False)
