"""Add multiple spanning tree instance data to devices and ports.

Revision ID: 030
Revises: 029
Create Date: 2026-10-15

Nullable JSONB columns filled best effort from IEEE8021-MSTP-MIB for MSTP
bridges during STP collection:
- devices.stp_instances: list of MSTIs {id, bridge_id, root_id, root_cost,
  root_port, vlans}.
- ports.stp_instances: MSTI id (string) -> {state, role}.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "030"
down_revision: Union[str, None] = "029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("stp_instances", JSONB, nullable=True))
    op.add_column("ports", sa.Column("stp_instances", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("ports", "stp_instances")
    op.drop_column("devices", "stp_instances")
