"""Add per-device scan refresh state.

Revision ID: 021
Revises: 020
Create Date: 2026-10-06

- devices.if_names: ifIndex (string) -> [ifDescr, ifAlias]; devices.if_names_at:
  time of the last full name walk. Frequent link/MAC scans read names from the
  cache and only walk interface status and speed.
- devices.vlan_at / devices.stp_at: time VLAN data (PVID, tagged VLANs, VLAN
  names) and spanning tree data were last collected. MAC scans only re-walk
  them when the configured VLAN / STP interval has passed.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("if_names", JSONB, nullable=True))
    op.add_column("devices", sa.Column("if_names_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("vlan_at", sa.DateTime(), nullable=True))
    op.add_column("devices", sa.Column("stp_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "stp_at")
    op.drop_column("devices", "vlan_at")
    op.drop_column("devices", "if_names_at")
    op.drop_column("devices", "if_names")
