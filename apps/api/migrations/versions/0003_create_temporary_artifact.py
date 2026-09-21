"""Create durable temporary artifact records.

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "temporary_artifact",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("owner_session_id", sa.String(length=255), nullable=False),
        sa.Column("storage_name", sa.String(length=255), nullable=False, unique=True),
        sa.Column("download_name", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("retrieved_at", sa.DateTime(timezone=True)),
        sa.Column("retrieval_lease_expires_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "ix_temporary_artifact_owner_expiry",
        "temporary_artifact",
        ["owner_session_id", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_temporary_artifact_owner_expiry", table_name="temporary_artifact")
    op.drop_table("temporary_artifact")
