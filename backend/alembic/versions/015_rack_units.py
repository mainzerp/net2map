"""Add rack-unit (U) modeling columns for the rack elevation view.

Revision ID: 015
Revises: 014
Create Date: 2026-09-20

Adds racks.height_u (usable rack units, default 42) plus
devices.rack_u_position (1-based bottom U position, null = not placed) and
devices.u_height (rack units occupied, default 1).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "racks",
        sa.Column("height_u", sa.Integer(), nullable=False, server_default="42"),
    )
    op.add_column(
        "devices",
        sa.Column("rack_u_position", sa.Integer(), nullable=True),
    )
    op.add_column(
        "devices",
        sa.Column("u_height", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_column("devices", "u_height")
    op.drop_column("devices", "rack_u_position")
    op.drop_column("racks", "height_u")
