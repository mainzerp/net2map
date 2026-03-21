"""Add priority column to credentials for fallback chains.

Revision ID: 008
Revises: 007
"""
import sqlalchemy as sa

from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("credentials", sa.Column("priority", sa.Integer, server_default="0", nullable=False))
    # Drop the existing unique constraint/index on ip
    op.drop_constraint("credentials_ip_key", "credentials", type_="unique")
    # Add composite unique constraint on (ip, priority)
    op.create_unique_constraint("uq_credential_ip_priority", "credentials", ["ip", "priority"])


def downgrade():
    op.drop_constraint("uq_credential_ip_priority", "credentials", type_="unique")
    op.create_unique_constraint("credentials_ip_key", "credentials", ["ip"])
    op.drop_column("credentials", "priority")
