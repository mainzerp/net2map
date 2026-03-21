"""Convert JSON text columns to JSONB.

Revision ID: 004
Revises: 003
Create Date: 2026-02-25

"""
from typing import Sequence, Union

from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (table, column, default_value)
_COLUMNS = [
    ("scan_runs", "devices_snapshot_json", "[]"),
    ("scan_runs", "links_snapshot_json",   "[]"),
    ("ports",     "endpoint_details_json", "[]"),
]


def upgrade() -> None:
    for table, col, default in _COLUMNS:
        # Cast existing text data to jsonb in-place
        op.execute(
            f'ALTER TABLE {table} '
            f'ALTER COLUMN {col} TYPE JSONB USING {col}::jsonb'
        )
        op.execute(
            f"ALTER TABLE {table} "
            f"ALTER COLUMN {col} SET DEFAULT '{default}'::jsonb"
        )


def downgrade() -> None:
    for table, col, default in _COLUMNS:
        op.execute(
            f'ALTER TABLE {table} '
            f'ALTER COLUMN {col} TYPE TEXT USING {col}::text'
        )
        op.execute(
            f"ALTER TABLE {table} "
            f"ALTER COLUMN {col} SET DEFAULT '{default}'"
        )
