"""Add spanning tree and VLAN name columns to devices and ports.

Revision ID: 019
Revises: 018
Create Date: 2026-10-15

Adds nullable columns filled best effort from BRIDGE-MIB / RSTP-MIB /
Q-BRIDGE-MIB during SNMP scans:
- ports.stp_state, ports.stp_role, ports.stp_path_cost: per-port spanning
  tree state, derived role and path cost (default instance only).
- devices.stp_protocol, stp_bridge_id, stp_root_id, stp_root_cost,
  stp_root_port: bridge-level spanning tree summary.
- devices.vlan_names: VLAN id (string) -> name map from dot1qVlanStaticName.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ports", sa.Column("stp_state", sa.String(16), nullable=True))
    op.add_column("ports", sa.Column("stp_role", sa.String(16), nullable=True))
    op.add_column("ports", sa.Column("stp_path_cost", sa.Integer(), nullable=True))
    op.add_column("devices", sa.Column("stp_protocol", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("stp_bridge_id", sa.String(32), nullable=True))
    op.add_column("devices", sa.Column("stp_root_id", sa.String(32), nullable=True))
    op.add_column("devices", sa.Column("stp_root_cost", sa.Integer(), nullable=True))
    op.add_column("devices", sa.Column("stp_root_port", sa.String(64), nullable=True))
    op.add_column("devices", sa.Column("vlan_names", JSONB, nullable=True, server_default="{}"))


def downgrade() -> None:
    op.drop_column("devices", "vlan_names")
    op.drop_column("devices", "stp_root_port")
    op.drop_column("devices", "stp_root_cost")
    op.drop_column("devices", "stp_root_id")
    op.drop_column("devices", "stp_bridge_id")
    op.drop_column("devices", "stp_protocol")
    op.drop_column("ports", "stp_path_cost")
    op.drop_column("ports", "stp_role")
    op.drop_column("ports", "stp_state")
