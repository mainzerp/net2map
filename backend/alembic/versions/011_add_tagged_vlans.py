"""Add tagged_vlans JSONB column to ports table.

Revision ID: 011
Revises: 010
Create Date: 2026-03-09

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ports", sa.Column("tagged_vlans", JSONB, server_default="[]"))


def downgrade() -> None:
    op.drop_column("ports", "tagged_vlans")
