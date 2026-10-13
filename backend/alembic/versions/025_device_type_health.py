"""Add device type and health status columns to devices.

Revision ID: 025
Revises: 024
Create Date: 2026-10-20

- devices.device_type: "switch" | "firewall" | "ups" | "server", derived from
  the detected vendor during a scan (default "switch").
- devices.health: normalized health snapshot (UPS battery / output values or
  server subsystem conditions) collected via SNMP; NULL when not reported.
- devices.health_updated_at: time the health snapshot was collected.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "025"
down_revision: Union[str, None] = "024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("device_type", sa.String(16), nullable=False, server_default="switch"),
    )
    op.add_column("devices", sa.Column("health", JSONB, nullable=True))
    op.add_column("devices", sa.Column("health_updated_at", sa.DateTime(), nullable=True))
    # Existing OPNsense devices were scanned before the type existed.
    op.execute("UPDATE devices SET device_type = 'firewall' WHERE vendor = 'opnsense'")


def downgrade() -> None:
    op.drop_column("devices", "health_updated_at")
    op.drop_column("devices", "health")
    op.drop_column("devices", "device_type")
