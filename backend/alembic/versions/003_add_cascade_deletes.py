"""Add ON DELETE CASCADE to foreign keys.

Revision ID: 003
Revises: 002
Create Date: 2026-02-25

"""
from typing import Sequence, Union

from sqlalchemy import inspect, text

from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (table, local_col, referred_table, referred_col, new_constraint_name)
_FK_SPECS = [
    ("ports",       "device_id",   "devices",        "id", "fk_ports_device_id"),
    ("devices",     "rack_id",     "racks",          "id", "fk_devices_rack_id"),
    ("devices",     "class_id",    "switch_classes",  "id", "fk_devices_class_id"),
    ("devices",     "model_id",    "switch_models",   "id", "fk_devices_model_id"),
    ("credentials", "profile_id",  "snmp_profiles",   "id", "fk_credentials_profile_id"),
    ("credentials", "rack_id",     "racks",           "id", "fk_credentials_rack_id"),
    ("credentials", "class_id",    "switch_classes",   "id", "fk_credentials_class_id"),
    ("scan_run_switch_metrics", "scan_run_id", "scan_runs", "id", "fk_srsm_scan_run_id"),
]


def _find_fk_name(connection, table, local_col, referred_table):
    """Locate the existing FK constraint name via introspection."""
    insp = inspect(connection)
    for fk in insp.get_foreign_keys(table):
        if fk["constrained_columns"] == [local_col] and fk["referred_table"] == referred_table:
            return fk["name"]
    return None


def upgrade() -> None:
    conn = op.get_bind()
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        old_name = _find_fk_name(conn, table, col, ref_table)
        if old_name:
            conn.execute(text(
                f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS "{old_name}"'
            ))
        op.create_foreign_key(new_name, table, ref_table, [col], [ref_col], ondelete="CASCADE")


def downgrade() -> None:
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        op.drop_constraint(new_name, table, type_="foreignkey")
        op.create_foreign_key(None, table, ref_table, [col], [ref_col])
