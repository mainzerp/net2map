"""Record the scan type of each scan run.

Revision ID: 033
Revises: 032
Create Date: 2026-10-15

- scan_runs.scan_type: kind of the run (full, discovery, ports, links, macs,
  ranges, dry_run). The scan history diffs a run only against the previous
  run of the same kind; before, a range scan was diffed against a device scan
  and reported every device as removed. Existing rows stay NULL and are
  diffed among themselves.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "033"
down_revision: Union[str, None] = "032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("scan_runs", sa.Column("scan_type", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("scan_runs", "scan_type")
