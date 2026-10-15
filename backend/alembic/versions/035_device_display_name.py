"""Manual display name of network devices.

Revision ID: 035
Revises: 034
Create Date: 2026-10-15

- devices.display_name: name set by the user, shown everywhere instead of
  the scanned names. Empty means: fall back to the label, then sysName, the
  reverse DNS name and the IP.
- Data: devices.label is re-synced from the linked credential label (lowest
  priority number first). The label was only copied once at device creation,
  so later credential renames never reached the device. The downgrade keeps
  the synced labels.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "035"
down_revision: Union[str, None] = "034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("display_name", sa.String(120), nullable=False, server_default=""),
    )
    op.execute(
        sa.text(
            "UPDATE devices SET label = ("
            " SELECT c.label FROM credentials c"
            " WHERE c.device_id = devices.id AND c.label <> ''"
            " ORDER BY c.priority, c.id LIMIT 1"
            ") WHERE EXISTS ("
            " SELECT 1 FROM credentials c WHERE c.device_id = devices.id AND c.label <> ''"
            ")"
        )
    )


def downgrade() -> None:
    op.drop_column("devices", "display_name")
