"""Add ping-only devices and rack sides / depth.

Revision ID: 027
Revises: 026
Create Date: 2026-11-03

- credentials.snmp_enabled: false registers a ping-only host; the scan never
  tries SNMP for it and creates/updates its Device from ping results alone.
- devices.ping_only: set by the scan while the device is monitored by ping only.
- devices.rack_side / rack_items.rack_side: "front" | "rear" side of the rack
  the object is mounted on (default "front").
- devices.full_depth / rack_items.full_depth: the object occupies its U range
  on both rack sides (default false).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "027"
down_revision: Union[str, None] = "026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "credentials",
        sa.Column("snmp_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "devices",
        sa.Column("ping_only", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    for table in ("devices", "rack_items"):
        op.add_column(table, sa.Column("rack_side", sa.String(8), nullable=False, server_default="front"))
        op.add_column(table, sa.Column("full_depth", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    for table in ("rack_items", "devices"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("full_depth")
            batch.drop_column("rack_side")
    with op.batch_alter_table("devices") as batch:
        batch.drop_column("ping_only")
    with op.batch_alter_table("credentials") as batch:
        batch.drop_column("snmp_enabled")
