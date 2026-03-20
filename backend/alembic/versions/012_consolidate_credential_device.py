"""Consolidate Credential/Device: move metadata to Device, add device_id FK.

Revision ID: 012
Revises: 011
Create Date: 2026-03-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Step 1: Add new columns to devices
    op.add_column("devices", sa.Column("label", sa.String, server_default="", nullable=False))
    op.add_column("devices", sa.Column("enabled", sa.Boolean, server_default="true", nullable=False))
    op.add_column("devices", sa.Column("is_managed", sa.Boolean, server_default="false", nullable=False))

    # Step 2: Add device_id FK to credentials
    op.add_column("credentials", sa.Column("device_id", sa.Integer, nullable=True))
    op.create_foreign_key(
        "fk_credentials_device_id", "credentials", "devices",
        ["device_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_credentials_device_id", "credentials", ["device_id"])

    # Step 3: Data migration
    # 3a: Link credentials to devices by IP
    op.execute(sa.text("""
        UPDATE credentials
        SET device_id = (SELECT d.id FROM devices d WHERE d.ip = credentials.ip LIMIT 1)
        WHERE EXISTS (SELECT 1 FROM devices d WHERE d.ip = credentials.ip)
    """))

    # 3b: Copy metadata from primary credential (priority=0) to device
    op.execute(sa.text("""
        UPDATE devices
        SET
            label = COALESCE(
                (SELECT c.label FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1),
                devices.sys_name
            ),
            rack_id = COALESCE(
                (SELECT c.rack_id FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1),
                devices.rack_id
            ),
            class_id = COALESCE(
                (SELECT c.class_id FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1),
                devices.class_id
            ),
            vendor = CASE
                WHEN (SELECT c.vendor FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
                THEN (SELECT c.vendor FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
                ELSE devices.vendor
            END,
            model = CASE
                WHEN (SELECT c.model FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
                THEN (SELECT c.model FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
                ELSE devices.model
            END,
            location = CASE
                WHEN (SELECT c.location FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
                THEN (SELECT c.location FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
                ELSE devices.location
            END,
            is_managed = true,
            enabled = COALESCE(
                (SELECT c.enabled FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1),
                true
            )
        WHERE EXISTS (SELECT 1 FROM credentials c WHERE c.ip = devices.ip)
    """))

    # Step 4: Drop metadata columns from credentials
    op.drop_constraint("fk_credentials_rack_id", "credentials", type_="foreignkey")
    op.drop_constraint("fk_credentials_class_id", "credentials", type_="foreignkey")
    op.drop_column("credentials", "rack_id")
    op.drop_column("credentials", "class_id")
    op.drop_column("credentials", "vendor")
    op.drop_column("credentials", "model")
    op.drop_column("credentials", "location")


def downgrade() -> None:
    # Re-add metadata columns to credentials
    op.add_column("credentials", sa.Column("location", sa.String, server_default="", nullable=True))
    op.add_column("credentials", sa.Column("vendor", sa.String, server_default="", nullable=True))
    op.add_column("credentials", sa.Column("model", sa.String, server_default="", nullable=True))
    op.add_column("credentials", sa.Column("rack_id", sa.Integer, nullable=True))
    op.add_column("credentials", sa.Column("class_id", sa.Integer, nullable=True))
    op.create_foreign_key("fk_credentials_rack_id", "credentials", "racks", ["rack_id"], ["id"])
    op.create_foreign_key("fk_credentials_class_id", "credentials", "switch_classes", ["class_id"], ["id"])

    # Copy metadata back from devices to credentials (by IP match)
    op.execute(sa.text("""
        UPDATE credentials
        SET
            location = COALESCE((SELECT d.location FROM devices d WHERE d.ip = credentials.ip LIMIT 1), ''),
            vendor = COALESCE((SELECT d.vendor FROM devices d WHERE d.ip = credentials.ip LIMIT 1), ''),
            model = COALESCE((SELECT d.model FROM devices d WHERE d.ip = credentials.ip LIMIT 1), ''),
            rack_id = (SELECT d.rack_id FROM devices d WHERE d.ip = credentials.ip LIMIT 1),
            class_id = (SELECT d.class_id FROM devices d WHERE d.ip = credentials.ip LIMIT 1)
        WHERE EXISTS (SELECT 1 FROM devices d WHERE d.ip = credentials.ip)
    """))

    # Drop device_id FK from credentials
    op.drop_index("ix_credentials_device_id", "credentials")
    op.drop_constraint("fk_credentials_device_id", "credentials", type_="foreignkey")
    op.drop_column("credentials", "device_id")

    # Drop new columns from devices
    op.drop_column("devices", "is_managed")
    op.drop_column("devices", "enabled")
    op.drop_column("devices", "label")
