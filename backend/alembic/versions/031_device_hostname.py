"""Add the reverse DNS name of network devices.

Revision ID: 031
Revises: 030
Create Date: 2026-10-15

- devices.hostname VARCHAR(255) NULL: PTR name of the management IP, resolved
  during discovery and full scans (a failed lookup keeps the stored name).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "031"
down_revision: Union[str, None] = "030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("hostname", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "hostname")
