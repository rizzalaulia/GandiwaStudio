"""Create the disposable manifest-derived creative index.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "creative_index",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("content_type", sa.String(length=16), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("relative_path", sa.String(length=1024), nullable=False),
        sa.UniqueConstraint(
            "project_id",
            "asset_id",
            "revision",
            name="uq_creative_index_project_asset_revision",
        ),
    )
    op.create_index("ix_creative_index_project", "creative_index", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_creative_index_project", table_name="creative_index")
    op.drop_table("creative_index")
