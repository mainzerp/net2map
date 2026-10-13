"""Add buildings and floors for the topology map.

Revision ID: 026
Revises: 025
Create Date: 2026-10-27

- buildings: label, description, sort_order.
- floors: per-building floors with their own map background (bg_ext,
  bg_version) and background settings (bg_opacity, bg_scale, bg_color).
- racks.floor_id / devices.floor_id: nullable, ON DELETE SET NULL. A racked
  device's effective floor is its rack's floor.

Data step: an existing installation (racks, devices, map_* app settings or a
legacy /data/map-background.<ext> file) gets a "Main building" with a "Ground
floor" that receives the map settings, all racks, all unracked devices and the
legacy background file (renamed to floor-<id>-background.<ext>). File errors
are logged and never fail the migration.

Downgrade drops the columns and tables. A moved background file is NOT moved
back to /data/map-background.<ext>; rename it manually if needed.
"""
import logging
import os
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "026"
down_revision: Union[str, None] = "025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_log = logging.getLogger("alembic.runtime.migration")

_LEGACY_BG_NAME = "map-background"
_BG_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")


def _data_dir() -> str:
    """Background directory; shared.file_settings.MAP_BG_DIR when importable (tests patch it)."""
    try:
        from shared import file_settings
        return file_settings.MAP_BG_DIR
    except Exception:
        return "/data"


def _find_legacy_bg(data_dir: str):
    try:
        if not os.path.isdir(data_dir):
            return None
        for ext in _BG_EXTENSIONS:
            path = os.path.join(data_dir, _LEGACY_BG_NAME + ext)
            if os.path.isfile(path):
                return path, ext
    except OSError as exc:
        _log.warning("026: cannot inspect %s: %s", data_dir, exc)
    return None


def upgrade() -> None:
    op.create_table(
        "buildings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_buildings_id", "buildings", ["id"])
    op.create_table(
        "floors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("building_id", sa.Integer(), sa.ForeignKey("buildings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bg_ext", sa.String(10), nullable=True),
        sa.Column("bg_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bg_opacity", sa.Float(), nullable=False, server_default="0.3"),
        sa.Column("bg_scale", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("bg_color", sa.String(20), nullable=False, server_default="#020817"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_floors_id", "floors", ["id"])
    op.create_index("ix_floors_building_id", "floors", ["building_id"])

    for table in ("racks", "devices"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("floor_id", sa.Integer(), nullable=True))
            batch.create_foreign_key(f"fk_{table}_floor_id", "floors", ["floor_id"], ["id"], ondelete="SET NULL")
            batch.create_index(f"ix_{table}_floor_id", ["floor_id"])

    _migrate_existing_data()


def _migrate_existing_data() -> None:
    conn = op.get_bind()
    has_racks = conn.execute(sa.text("SELECT COUNT(*) FROM racks")).scalar() or 0
    has_devices = conn.execute(sa.text("SELECT COUNT(*) FROM devices")).scalar() or 0
    settings = dict(conn.execute(sa.text(
        "SELECT key, value FROM app_settings WHERE key IN ('map_opacity', 'map_scale', 'map_bg_color')"
    )).fetchall())
    data_dir = _data_dir()
    legacy = _find_legacy_bg(data_dir)
    if not (has_racks or has_devices or settings or legacy):
        return

    conn.execute(sa.text("INSERT INTO buildings (label, sort_order) VALUES ('Main building', 0)"))
    building_id = conn.execute(sa.text("SELECT MAX(id) FROM buildings")).scalar()

    def _float(key: str, default: float, low: float, high: float) -> float:
        try:
            return max(low, min(high, float(settings[key])))
        except (KeyError, TypeError, ValueError):
            return default

    conn.execute(
        sa.text(
            "INSERT INTO floors (building_id, label, sort_order, bg_version, bg_opacity, bg_scale, bg_color)"
            " VALUES (:building_id, 'Ground floor', 0, 0, :opacity, :scale, :color)"
        ),
        {
            "building_id": building_id,
            "opacity": _float("map_opacity", 0.3, 0.0, 1.0),
            "scale": _float("map_scale", 1.0, 0.1, 10.0),
            "color": (settings.get("map_bg_color") or "#020817")[:20],
        },
    )
    floor_id = conn.execute(sa.text("SELECT MAX(id) FROM floors")).scalar()
    conn.execute(sa.text("UPDATE racks SET floor_id = :f"), {"f": floor_id})
    conn.execute(sa.text("UPDATE devices SET floor_id = :f WHERE rack_id IS NULL"), {"f": floor_id})

    if not legacy:
        return
    src, ext = legacy
    if not os.access(data_dir, os.W_OK):
        _log.warning("026: %s is not writable; legacy background %s left in place", data_dir, src)
        return
    dest = os.path.join(data_dir, f"floor-{floor_id}-background{ext}")
    try:
        os.replace(src, dest)
    except OSError as exc:
        _log.warning("026: could not move legacy background %s to %s: %s", src, dest, exc)
        return
    conn.execute(sa.text("UPDATE floors SET bg_ext = :ext, bg_version = 1 WHERE id = :f"), {"ext": ext, "f": floor_id})


def downgrade() -> None:
    # Moved background files are not renamed back (see module docstring).
    for table in ("devices", "racks"):
        with op.batch_alter_table(table) as batch:
            batch.drop_index(f"ix_{table}_floor_id")
            batch.drop_constraint(f"fk_{table}_floor_id", type_="foreignkey")
            batch.drop_column("floor_id")
    op.drop_index("ix_floors_building_id", table_name="floors")
    op.drop_index("ix_floors_id", table_name="floors")
    op.drop_table("floors")
    op.drop_index("ix_buildings_id", table_name="buildings")
    op.drop_table("buildings")
