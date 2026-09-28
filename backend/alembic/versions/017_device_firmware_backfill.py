"""Backfill devices.firmware NULLs and add a server default.

Revision ID: 017
Revises: 016
Create Date: 2026-09-22

Rows created before migration 016 have firmware=NULL, which breaks DeviceOut
serialization (firmware: str). Backfill them to '' and set a server default so
non-ORM inserts also get a string instead of NULL.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE devices SET firmware = '' WHERE firmware IS NULL")
    op.alter_column("devices", "firmware", server_default="")


def downgrade() -> None:
    op.alter_column("devices", "firmware", server_default=None)
