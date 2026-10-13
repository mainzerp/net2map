"""Add the rack_items table for manually maintained rack placeholders.

Revision ID: 024
Revises: 023
Create Date: 2026-10-13

Rack items (patch panels, blanks, cable managers, shelves) only occupy U space
in the rack elevation: no ports, no cabling, never scanned.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "024"
down_revision: Union[str, None] = "023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "rack_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("rack_id", sa.Integer(), sa.ForeignKey("racks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False, server_default="patch_panel"),
        sa.Column("label", sa.String(), nullable=False, server_default=""),
        sa.Column("rack_u_position", sa.Integer(), nullable=False),
        sa.Column("u_height", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_rack_items_id", "rack_items", ["id"])
    op.create_index("ix_rack_items_rack_id", "rack_items", ["rack_id"])


def downgrade() -> None:
    op.drop_index("ix_rack_items_rack_id", table_name="rack_items")
    op.drop_index("ix_rack_items_id", table_name="rack_items")
    op.drop_table("rack_items")
