"""Add ping candidates.

Revision ID: 028
Revises: 027
Create Date: 2026-11-04

- ping_candidates: discovery-range hosts that answered ping but no SNMP
  profile and have neither a Device nor a Credential. The UI offers them for
  adoption as ping-only devices; dismissed hides them from the default list.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ping_candidates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ip", sa.String(), nullable=False),
        sa.Column("rtt_ms", sa.Integer(), nullable=True),
        sa.Column("first_seen", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_ping_candidates_id", "ping_candidates", ["id"])
    op.create_index("ix_ping_candidates_ip", "ping_candidates", ["ip"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_ping_candidates_ip", table_name="ping_candidates")
    op.drop_index("ix_ping_candidates_id", table_name="ping_candidates")
    op.drop_table("ping_candidates")
