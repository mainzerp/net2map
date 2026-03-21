"""Initial schema — all 11 tables.

Revision ID: 001
Revises:
Create Date: 2026-02-23

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Tables with no foreign-key dependencies first ──────────────────────

    op.create_table(
        "racks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("room", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("map_x", sa.Float(), nullable=True),
        sa.Column("map_y", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_racks_id"), "racks", ["id"], unique=False)

    op.create_table(
        "switch_classes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_switch_classes_id"), "switch_classes", ["id"], unique=False)

    op.create_table(
        "switch_models",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("ports_per_row", sa.Integer(), nullable=True),
        sa.Column("total_ports", sa.Integer(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index(op.f("ix_switch_models_id"), "switch_models", ["id"], unique=False)

    op.create_table(
        "snmp_profiles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("snmp_version", sa.String(), nullable=True),
        sa.Column("community", sa.String(), nullable=True),
        sa.Column("v3_security_level", sa.String(), nullable=True),
        sa.Column("v3_username", sa.String(), nullable=True),
        sa.Column("v3_auth_protocol", sa.String(), nullable=True),
        sa.Column("v3_auth_password", sa.String(), nullable=True),
        sa.Column("v3_priv_protocol", sa.String(), nullable=True),
        sa.Column("v3_priv_password", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_snmp_profiles_id"), "snmp_profiles", ["id"], unique=False)

    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_index(op.f("ix_app_settings_key"), "app_settings", ["key"], unique=False)

    op.create_table(
        "scan_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("scanned", sa.Integer(), nullable=True),
        sa.Column("found", sa.Integer(), nullable=True),
        sa.Column("links", sa.Integer(), nullable=True),
        sa.Column("max_workers", sa.Integer(), nullable=True),
        sa.Column("total_duration_ms", sa.Integer(), nullable=True),
        sa.Column("error_count", sa.Integer(), nullable=True),
        sa.Column("devices_snapshot_json", sa.Text(), nullable=True),
        sa.Column("links_snapshot_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_scan_runs_id"), "scan_runs", ["id"], unique=False)

    op.create_table(
        "topology_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("local_ip", sa.String(), nullable=False),
        sa.Column("local_port", sa.String(), nullable=True),
        sa.Column("remote_ip", sa.String(), nullable=True),
        sa.Column("remote_sys", sa.String(), nullable=True),
        sa.Column("remote_port", sa.String(), nullable=True),
        sa.Column("speed_label", sa.String(), nullable=True),
        sa.Column("discovered_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_topology_links_id"), "topology_links", ["id"], unique=False)

    # ── Tables with foreign-key dependencies ───────────────────────────────

    op.create_table(
        "credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("ip", sa.String(), nullable=False),
        sa.Column("snmp_port", sa.Integer(), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("snmp_version", sa.String(), nullable=True),
        sa.Column("community", sa.String(), nullable=True),
        sa.Column("v3_security_level", sa.String(), nullable=True),
        sa.Column("v3_username", sa.String(), nullable=True),
        sa.Column("v3_auth_protocol", sa.String(), nullable=True),
        sa.Column("v3_auth_password", sa.String(), nullable=True),
        sa.Column("v3_priv_protocol", sa.String(), nullable=True),
        sa.Column("v3_priv_password", sa.String(), nullable=True),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("rack_id", sa.Integer(), nullable=True),
        sa.Column("class_id", sa.Integer(), nullable=True),
        sa.Column("vendor", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["class_id"], ["switch_classes.id"]),
        sa.ForeignKeyConstraint(["profile_id"], ["snmp_profiles.id"]),
        sa.ForeignKeyConstraint(["rack_id"], ["racks.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ip"),
    )
    op.create_index(op.f("ix_credentials_id"), "credentials", ["id"], unique=False)

    op.create_table(
        "devices",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("sys_name", sa.String(), nullable=True),
        sa.Column("ip", sa.String(), nullable=False),
        sa.Column("sys_descr", sa.Text(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("vendor", sa.String(), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("ping_status", sa.String(), nullable=True),
        sa.Column("ping_rtt_ms", sa.Integer(), nullable=True),
        sa.Column("last_ping", sa.DateTime(), nullable=True),
        sa.Column("map_x", sa.Float(), nullable=True),
        sa.Column("map_y", sa.Float(), nullable=True),
        sa.Column("last_seen", sa.DateTime(), nullable=True),
        sa.Column("rack_id", sa.Integer(), nullable=True),
        sa.Column("class_id", sa.Integer(), nullable=True),
        sa.Column("model_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["class_id"], ["switch_classes.id"]),
        sa.ForeignKeyConstraint(["model_id"], ["switch_models.id"]),
        sa.ForeignKeyConstraint(["rack_id"], ["racks.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ip"),
    )
    op.create_index(op.f("ix_devices_id"), "devices", ["id"], unique=False)
    op.create_index(op.f("ix_devices_ip"), "devices", ["ip"], unique=False)
    op.create_index(op.f("ix_devices_sys_name"), "devices", ["sys_name"], unique=False)

    op.create_table(
        "ports",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("if_index", sa.Integer(), nullable=False),
        sa.Column("if_descr", sa.String(), nullable=True),
        sa.Column("if_alias", sa.String(), nullable=True),
        sa.Column("speed_mbps", sa.Integer(), nullable=True),
        sa.Column("oper_status", sa.Integer(), nullable=True),
        sa.Column("peer_mac", sa.String(), nullable=True),
        sa.Column("peer_ip", sa.String(), nullable=True),
        sa.Column("peer_host", sa.String(), nullable=True),
        sa.Column("endpoint_count", sa.Integer(), nullable=True),
        sa.Column("endpoint_details_json", sa.Text(), nullable=True),
        sa.Column("vlan", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ports_device_id"), "ports", ["device_id"], unique=False)
    op.create_index(op.f("ix_ports_id"), "ports", ["id"], unique=False)

    op.create_table(
        "scan_run_switch_metrics",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("scan_run_id", sa.Integer(), nullable=False),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["scan_run_id"], ["scan_runs.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_scan_run_switch_metrics_id"),
        "scan_run_switch_metrics",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_scan_run_switch_metrics_scan_run_id"),
        "scan_run_switch_metrics",
        ["scan_run_id"],
        unique=False,
    )


def downgrade() -> None:
    # Drop in reverse dependency order
    op.drop_index(
        op.f("ix_scan_run_switch_metrics_scan_run_id"),
        table_name="scan_run_switch_metrics",
    )
    op.drop_index(
        op.f("ix_scan_run_switch_metrics_id"),
        table_name="scan_run_switch_metrics",
    )
    op.drop_table("scan_run_switch_metrics")

    op.drop_index(op.f("ix_ports_id"), table_name="ports")
    op.drop_index(op.f("ix_ports_device_id"), table_name="ports")
    op.drop_table("ports")

    op.drop_index(op.f("ix_devices_sys_name"), table_name="devices")
    op.drop_index(op.f("ix_devices_ip"), table_name="devices")
    op.drop_index(op.f("ix_devices_id"), table_name="devices")
    op.drop_table("devices")

    op.drop_index(op.f("ix_credentials_id"), table_name="credentials")
    op.drop_table("credentials")

    op.drop_index(op.f("ix_topology_links_id"), table_name="topology_links")
    op.drop_table("topology_links")

    op.drop_index(op.f("ix_scan_runs_id"), table_name="scan_runs")
    op.drop_table("scan_runs")

    op.drop_index(op.f("ix_app_settings_key"), table_name="app_settings")
    op.drop_table("app_settings")

    op.drop_index(op.f("ix_snmp_profiles_id"), table_name="snmp_profiles")
    op.drop_table("snmp_profiles")

    op.drop_index(op.f("ix_switch_models_id"), table_name="switch_models")
    op.drop_table("switch_models")

    op.drop_index(op.f("ix_switch_classes_id"), table_name="switch_classes")
    op.drop_table("switch_classes")

    op.drop_index(op.f("ix_racks_id"), table_name="racks")
    op.drop_table("racks")
