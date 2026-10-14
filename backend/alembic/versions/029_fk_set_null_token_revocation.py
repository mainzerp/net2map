"""Align FK delete rules with the models and add users.revoked_before_ms.

Revision ID: 029
Revises: 028
Create Date: 2026-10-14

- devices.rack_id, devices.class_id, devices.model_id and
  credentials.profile_id: ON DELETE CASCADE (migration 003) -> ON DELETE SET
  NULL. Deleting a rack, switch class, switch model or SNMP profile detaches
  the referencing rows instead of deleting devices / credentials (the routers
  already null the references explicitly; the database now agrees).
  ports.device_id and scan_run_switch_metrics.scan_run_id keep CASCADE.
  Existing constraint names are found by introspection (like 003). SQLite
  cannot alter constraints in place; there the FK step is skipped (SQLite
  databases are created from the ORM metadata, which already declares the
  new rules).
- users.revoked_before_ms BIGINT NOT NULL DEFAULT 0: DB-backed session
  revocation (Redis is no longer required for it). Revoking all sessions of a
  user (deactivate, demote, password change, admin revoke-all, logout without
  Redis) sets it to the current unix time in milliseconds; token validation
  rejects every token issued at or before that instant. Tokens carry an
  "iat_ms" claim for a precise comparison; tokens without it (issued before
  this revision) fall back to their 1-second "iat" and count as revoked when
  issued in the same second as the revocation. 0 means never revoked.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy import inspect, text

from alembic import op

revision: str = "029"
down_revision: Union[str, None] = "028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (table, local_col, referred_table, referred_col, constraint_name)
_FK_SPECS = [
    ("devices",     "rack_id",    "racks",          "id", "fk_devices_rack_id"),
    ("devices",     "class_id",   "switch_classes", "id", "fk_devices_class_id"),
    ("devices",     "model_id",   "switch_models",  "id", "fk_devices_model_id"),
    ("credentials", "profile_id", "snmp_profiles",  "id", "fk_credentials_profile_id"),
]


def _find_fk_name(connection, table, local_col, referred_table):
    """Locate the existing FK constraint name via introspection."""
    insp = inspect(connection)
    for fk in insp.get_foreign_keys(table):
        if fk["constrained_columns"] == [local_col] and fk["referred_table"] == referred_table:
            return fk["name"]
    return None


def _set_fk_rules(ondelete: str) -> None:
    conn = op.get_bind()
    if conn.dialect.name == "sqlite":
        return
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        old_name = _find_fk_name(conn, table, col, ref_table)
        if old_name:
            conn.execute(text(f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS "{old_name}"'))
        op.create_foreign_key(new_name, table, ref_table, [col], [ref_col], ondelete=ondelete)


def upgrade() -> None:
    _set_fk_rules("SET NULL")
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("revoked_before_ms", sa.BigInteger(), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("revoked_before_ms")
    # Restore the migration-003 state.
    _set_fk_rules("CASCADE")
