"""Add ON DELETE CASCADE to dry_run_results.scan_run_id FK.

Revision ID: 010
Revises: 009
Create Date: 2026-03-09

"""
from typing import Sequence, Union

from sqlalchemy import inspect, text

from alembic import op

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "dry_run_results"
_COL = "scan_run_id"
_REF_TABLE = "scan_runs"
_REF_COL = "id"
_NEW_FK = "fk_dry_run_results_scan_run_id"


def upgrade() -> None:
    # Drop the unnamed FK created by migration 009, then recreate with CASCADE.
    conn = op.get_bind()
    insp = inspect(conn)
    for fk in insp.get_foreign_keys(_TABLE):
        if (fk["constrained_columns"] == [_COL]
                and fk["referred_table"] == _REF_TABLE):
            conn.execute(text(
                f'ALTER TABLE "{_TABLE}" DROP CONSTRAINT IF EXISTS "{fk["name"]}"'
            ))
            break
    op.create_foreign_key(
        _NEW_FK, _TABLE, _REF_TABLE, [_COL], [_REF_COL], ondelete="CASCADE"
    )


def downgrade() -> None:
    op.drop_constraint(_NEW_FK, _TABLE, type_="foreignkey")
    op.create_foreign_key(None, _TABLE, _REF_TABLE, [_COL], [_REF_COL])
