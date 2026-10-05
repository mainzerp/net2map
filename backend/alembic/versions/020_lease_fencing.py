"""Add the lease_fences table for database-side lease fencing.

Revision ID: 020
Revises: 019
Create Date: 2026-10-16

Each distributed lease (currently the Redis scan lock) hands out a strictly
increasing fencing token on acquisition. Guarded scan transactions upsert
their token into lease_fences before writing; the conditional upsert only
succeeds while the token is not lower than the stored one, so a stale lease
holder can no longer commit after a newer holder has written.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "020"
down_revision: Union[str, None] = "019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "lease_fences",
        sa.Column("name", sa.String(), primary_key=True),
        sa.Column("token", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("lease_fences")
