"""Add SNMPv3 engine ID columns to credentials.

Revision ID: 018
Revises: 017
Create Date: 2026-10-08

Adds three nullable, unencrypted columns (engine IDs are not secret):
- credentials.v3_engine_id: optional manual override of the authoritative
  SNMP engine ID (lowercase hex, no 0x prefix, 5-32 octets).
- credentials.discovered_engine_id: engine ID observed during the last
  successful scan (lowercase hex), read from SNMP-FRAMEWORK-MIB::snmpEngineID.0.
- credentials.engine_id_seen_at: timestamp of that observation.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("credentials", sa.Column("v3_engine_id", sa.String(), nullable=True))
    op.add_column("credentials", sa.Column("discovered_engine_id", sa.String(), nullable=True))
    op.add_column("credentials", sa.Column("engine_id_seen_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("credentials", "engine_id_seen_at")
    op.drop_column("credentials", "discovered_engine_id")
    op.drop_column("credentials", "v3_engine_id")
