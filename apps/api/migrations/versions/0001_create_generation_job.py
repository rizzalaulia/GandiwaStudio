"""Create the durable generation job foundation.

Revision ID: 0001
Revises: None
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "generation_job",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("job_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("provider_id", sa.String(length=36)),
        sa.Column("model_id", sa.String(length=36)),
        sa.Column("ruleset_snapshot_id", sa.String(length=36)),
        sa.Column("parameters", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("remote_job_id", sa.String(length=255)),
        sa.Column("lease_owner", sa.String(length=255)),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True)),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("error_code", sa.String(length=64)),
        sa.Column("redacted_error", sa.Text()),
        sa.Column("result_manifest", sa.JSON()),
        sa.CheckConstraint("priority >= 0", name="ck_generation_job_priority_nonnegative"),
        sa.CheckConstraint(
            "attempt_count >= 0",
            name="ck_generation_job_attempt_count_nonnegative",
        ),
    )
    op.create_index(
        "ix_generation_job_claim",
        "generation_job",
        ["status", "priority", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_generation_job_claim", table_name="generation_job")
    op.drop_table("generation_job")
