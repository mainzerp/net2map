"""Add allow_outside_rack column to switch_classes.

Revision ID: 003
Revises: 002
Create Date: 2026-02-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "switch_classes",
        sa.Column("allow_outside_rack", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column("switch_classes", "allow_outside_rack", server_default=None)


def downgrade() -> None:
    op.drop_column("switch_classes", "allow_outside_rack")
