"""Add devices.firmware for the collected software/firmware version.

Revision ID: 016
Revises: 015
Create Date: 2026-10-01

Adds devices.firmware, populated by the scan engine from the ENTITY-MIB
entPhysicalSoftwareRev OID with a sysDescr regex fallback.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("firmware", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("devices", "firmware")
