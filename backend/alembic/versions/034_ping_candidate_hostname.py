"""Reverse DNS name of ping candidates.

Revision ID: 034
Revises: 033
Create Date: 2026-10-15

- ping_candidates.hostname: PTR name resolved by range scans. Before, a
  candidate only showed a name when an endpoint with the same IP had one, so
  hosts without SNMP (access points, printers) never got a DNS name.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "034"
down_revision: Union[str, None] = "033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ping_candidates", sa.Column("hostname", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("ping_candidates", "hostname")
