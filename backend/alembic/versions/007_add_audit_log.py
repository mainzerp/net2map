"""Add audit_logs table for configuration change tracking.

Revision ID: 007
Revises: 006
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("timestamp", sa.DateTime, server_default=sa.func.now(), index=True),
        sa.Column("user_id", sa.Integer, nullable=True),
        sa.Column("username", sa.String, server_default=""),
        sa.Column("action", sa.String, nullable=False),
        sa.Column("resource", sa.String, nullable=False),
        sa.Column("resource_id", sa.String, server_default=""),
        sa.Column("details", JSONB, server_default="{}"),
    )


def downgrade():
    op.drop_table("audit_logs")
