"""Add the missing now() server defaults to created_at/updated_at columns.

Revision ID: 023
Revises: 022
Create Date: 2026-10-12

The ORM models declare server_default=func.now() for these columns, but the
earlier migrations created them without a default, so rows inserted without an
explicit value (e.g. every scan run) stored NULL. Existing NULL values stay
NULL: their real timestamps are unknown.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = [
    ("credentials", "created_at"),
    ("credentials", "updated_at"),
    ("racks", "created_at"),
    ("racks", "updated_at"),
    ("scan_runs", "created_at"),
    ("snmp_profiles", "created_at"),
    ("snmp_profiles", "updated_at"),
    ("switch_classes", "created_at"),
    ("switch_classes", "updated_at"),
    ("switch_models", "created_at"),
    ("switch_models", "updated_at"),
]


def upgrade() -> None:
    for table, column in COLUMNS:
        with op.batch_alter_table(table) as batch:
            batch.alter_column(column, existing_type=sa.DateTime(), server_default=sa.func.now())


def downgrade() -> None:
    for table, column in COLUMNS:
        with op.batch_alter_table(table) as batch:
            batch.alter_column(column, existing_type=sa.DateTime(), server_default=None)
