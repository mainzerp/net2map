"""Add vendor_override column to devices table.

Revision ID: 014
Revises: 013
Create Date: 2026-04-14

The flag replaces the previous runtime heuristic ("DB vendor differs from
auto-detected vendor"). Existing rows default to False, which matches the
heuristic's behaviour of only treating diverging vendors as overrides at
scan time.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("vendor_override", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("devices", "vendor_override")
