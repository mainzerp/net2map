"""Separate endpoints from devices into dedicated tables.

Revision ID: 013
Revises: 012
Create Date: 2026-03-21

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Step 1: Create endpoints table
    op.create_table(
        "endpoints",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("mac", sa.String, nullable=False, unique=True),
        sa.Column("ip", sa.String, nullable=True),
        sa.Column("hostname", sa.String, nullable=True),
        sa.Column("first_seen", sa.DateTime, server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime, server_default=sa.func.now()),
        sa.Column("ignored", sa.Boolean, server_default="false", nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
    )
    op.create_index("ix_endpoints_mac", "endpoints", ["mac"])
    op.create_index("ix_endpoints_ip", "endpoints", ["ip"])

    # Step 2: Create endpoint_port_associations table
    op.create_table(
        "endpoint_port_associations",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("endpoint_id", sa.Integer, sa.ForeignKey("endpoints.id", ondelete="CASCADE"), nullable=False),
        sa.Column("port_id", sa.Integer, sa.ForeignKey("ports.id", ondelete="CASCADE"), nullable=False),
        sa.Column("vlan_id", sa.Integer, nullable=True),
        sa.Column("last_seen", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index("ix_epa_endpoint_id", "endpoint_port_associations", ["endpoint_id"])
    op.create_index("ix_epa_port_id", "endpoint_port_associations", ["port_id"])
    op.create_unique_constraint("uq_epa_endpoint_port", "endpoint_port_associations", ["endpoint_id", "port_id"])

    # Step 3: Migrate data from ports.endpoint_details_json -> endpoints + associations
    conn = op.get_bind()

    # 3a: For each port with endpoint_details_json, extract entries
    ports_with_endpoints = conn.execute(sa.text(
        "SELECT id, device_id, endpoint_details_json, vlan FROM ports "
        "WHERE endpoint_details_json IS NOT NULL AND endpoint_details_json::text != '[]' AND endpoint_details_json::text != 'null'"
    )).fetchall()

    for port_row in ports_with_endpoints:
        port_id = port_row[0]
        details = port_row[2]
        port_vlan = port_row[3]

        if not details or not isinstance(details, list):
            continue

        for entry in details:
            if not isinstance(entry, dict):
                continue
            mac = (entry.get("mac") or "").strip()
            ip_addr = (entry.get("ip") or "").strip() or None
            host = (entry.get("host") or "").strip() or None

            if not mac:
                continue

            # Check if endpoint with this MAC already exists
            existing = conn.execute(sa.text(
                "SELECT id FROM endpoints WHERE mac = :mac"
            ), {"mac": mac}).fetchone()

            if existing:
                ep_id = existing[0]
                # Update with richer data if available
                if ip_addr:
                    conn.execute(sa.text(
                        "UPDATE endpoints SET ip = COALESCE(:ip, ip), hostname = COALESCE(:host, hostname), last_seen = now() WHERE id = :id"
                    ), {"ip": ip_addr, "host": host, "id": ep_id})
            else:
                result = conn.execute(sa.text(
                    "INSERT INTO endpoints (mac, ip, hostname) VALUES (:mac, :ip, :host) RETURNING id"
                ), {"mac": mac, "ip": ip_addr, "host": host})
                ep_id = result.fetchone()[0]

            # Upsert association
            assoc_exists = conn.execute(sa.text(
                "SELECT id FROM endpoint_port_associations WHERE endpoint_id = :ep AND port_id = :port"
            ), {"ep": ep_id, "port": port_id}).fetchone()

            if not assoc_exists:
                vlan_val = port_vlan if port_vlan and port_vlan != 0 else None
                conn.execute(sa.text(
                    "INSERT INTO endpoint_port_associations (endpoint_id, port_id, vlan_id) VALUES (:ep, :port, :vlan)"
                ), {"ep": ep_id, "port": port_id, "vlan": vlan_val})

    # Step 4: Delete unmanaged device rows (is_managed=False)
    conn.execute(sa.text("DELETE FROM devices WHERE is_managed = false"))

    # Step 5: Drop is_managed from devices
    op.drop_column("devices", "is_managed")

    # Step 6: Drop endpoint columns from ports
    op.drop_column("ports", "peer_mac")
    op.drop_column("ports", "peer_ip")
    op.drop_column("ports", "peer_host")
    op.drop_column("ports", "endpoint_count")
    op.drop_column("ports", "endpoint_details_json")


def downgrade() -> None:
    # Re-add endpoint columns to ports
    op.add_column("ports", sa.Column("endpoint_details_json", JSONB, server_default="[]"))
    op.add_column("ports", sa.Column("endpoint_count", sa.Integer, server_default="0"))
    op.add_column("ports", sa.Column("peer_host", sa.String, server_default=""))
    op.add_column("ports", sa.Column("peer_ip", sa.String, server_default=""))
    op.add_column("ports", sa.Column("peer_mac", sa.String, server_default=""))

    # Re-add is_managed to devices (all existing are managed)
    op.add_column("devices", sa.Column("is_managed", sa.Boolean, server_default="true", nullable=False))

    # Best-effort: restore endpoint data to ports from endpoint_port_associations
    conn = op.get_bind()
    associations = conn.execute(sa.text(
        "SELECT epa.port_id, e.mac, e.ip, e.hostname "
        "FROM endpoint_port_associations epa "
        "JOIN endpoints e ON e.id = epa.endpoint_id"
    )).fetchall()

    from collections import defaultdict
    port_endpoints = defaultdict(list)
    for assoc in associations:
        port_id, mac, ip_addr, hostname = assoc
        port_endpoints[port_id].append({"mac": mac or "", "ip": ip_addr or "", "host": hostname or ""})

    import json
    for port_id, details in port_endpoints.items():
        first = details[0] if details else {}
        conn.execute(sa.text(
            "UPDATE ports SET peer_mac = :pm, peer_ip = :pi, peer_host = :ph, "
            "endpoint_count = :ec, endpoint_details_json = :edj WHERE id = :pid"
        ), {
            "pm": first.get("mac", ""),
            "pi": first.get("ip", ""),
            "ph": first.get("host", ""),
            "ec": len(details),
            "edj": json.dumps(details),
            "pid": port_id,
        })

    # Drop new tables
    op.drop_table("endpoint_port_associations")
    op.drop_table("endpoints")
