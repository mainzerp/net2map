"""Move discovery ranges into their own table.

Revision ID: 032
Revises: 031
Create Date: 2026-10-20

- scan_ranges: one row per discovery range (normalized CIDR or single IP) with
  label, enabled flag, optional per-range interval (NULL = global
  discovery_interval_sec), optional SNMP profile subset (NULL/[] = all
  profiles) and last_scan_at (naive UTC).
- ping_candidates.snmp_checked_at: last time the host was actually
  SNMP-probed; range scans skip the SNMP probe inside a configurable window.
- Data: the legacy app_settings "discovery_scan_ranges" JSON list is copied
  into scan_ranges (invalid entries, duplicates and ranges with more than
  65536 addresses are skipped) and the settings row is removed. The
  downgrade writes the CIDR list back.
"""
import ipaddress
import json
from typing import List, Optional, Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "032"
down_revision: Union[str, None] = "031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LEGACY_KEY = "discovery_scan_ranges"
_MAX_ADDRESSES = 65536


def _normalize(entry: str) -> Optional[str]:
    entry = str(entry or "").strip()
    if not entry:
        return None
    try:
        network = ipaddress.ip_network(entry, strict=False)
    except ValueError:
        return None
    if network.num_addresses > _MAX_ADDRESSES:
        return None
    if network.num_addresses == 1:
        return str(network.network_address)
    return str(network)


def _legacy_ranges(raw: Optional[str]) -> List[str]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    result: List[str] = []
    for item in value:
        cidr = _normalize(item)
        if cidr and cidr not in result:
            result.append(cidr)
    return result


def upgrade() -> None:
    op.create_table(
        "scan_ranges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cidr", sa.String(64), nullable=False),
        sa.Column("label", sa.String(128), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("interval_sec", sa.Integer(), nullable=True),
        sa.Column("profile_ids", JSONB, nullable=True),
        sa.Column("last_scan_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("cidr"),
    )
    op.create_index("ix_scan_ranges_id", "scan_ranges", ["id"])
    op.add_column("ping_candidates", sa.Column("snmp_checked_at", sa.DateTime(), nullable=True))

    bind = op.get_bind()
    raw = bind.execute(
        sa.text("SELECT value FROM app_settings WHERE key = :key"), {"key": _LEGACY_KEY}
    ).scalar()
    ranges = _legacy_ranges(raw)
    if ranges:
        scan_ranges = sa.table(
            "scan_ranges",
            sa.column("cidr", sa.String),
            sa.column("label", sa.String),
            sa.column("enabled", sa.Boolean),
        )
        op.bulk_insert(scan_ranges, [{"cidr": c, "label": "", "enabled": True} for c in ranges])
    bind.execute(sa.text("DELETE FROM app_settings WHERE key = :key"), {"key": _LEGACY_KEY})


def downgrade() -> None:
    bind = op.get_bind()
    ranges = [row[0] for row in bind.execute(sa.text("SELECT cidr FROM scan_ranges ORDER BY cidr")).fetchall()]
    bind.execute(sa.text("DELETE FROM app_settings WHERE key = :key"), {"key": _LEGACY_KEY})
    bind.execute(
        sa.text("INSERT INTO app_settings (key, value) VALUES (:key, :value)"),
        {"key": _LEGACY_KEY, "value": json.dumps(ranges)},
    )
    op.drop_column("ping_candidates", "snmp_checked_at")
    op.drop_index("ix_scan_ranges_id", table_name="scan_ranges")
    op.drop_table("scan_ranges")
