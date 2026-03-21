"""Add dry_run_results table for persisting dry-run scan previews.

Revision ID: 009
Revises: 008
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "dry_run_results",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("scan_run_id", sa.Integer, sa.ForeignKey("scan_runs.id"), nullable=True),
        sa.Column("preview_json", JSONB, server_default="[]"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("dry_run_results")
