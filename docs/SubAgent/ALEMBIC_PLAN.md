# Alembic Integration — Implementation Plan

## Overview

This plan adds Alembic database migration management to the switch-map backend. It replaces all seven `_ensure_*` ad-hoc migration functions with a single initial migration and establishes the foundation for all future schema changes.

---

## Checklist

- [ ] Step 1 — Add `alembic` to `requirements.txt`
- [ ] Step 2 — Create `backend/alembic.ini`
- [ ] Step 3 — Create `backend/alembic/env.py`
- [ ] Step 4 — Create `backend/alembic/script.py.mako`
- [ ] Step 5 — Create `backend/alembic/versions/` directory placeholder
- [ ] Step 6 — Create `backend/alembic/versions/001_initial_schema.py`
- [ ] Step 7 — Modify `backend/database.py`
- [ ] Step 8 — Modify `backend/entrypoint.sh`
- [ ] Step 9 — Modify `backend/main.py`
- [ ] Step 10 — Verify `backend/Dockerfile` (no change needed — `COPY . .` covers all new files)

---

## Step 1 — `backend/requirements.txt`

Add one line after `sqlalchemy==2.0.36`:

```
alembic==1.13.3
```

Full updated file:

```
fastapi==0.115.5
uvicorn[standard]==0.32.1
sqlalchemy==2.0.36
alembic==1.13.3
pydantic==2.9.2
python-multipart>=0.0.7
# pysnmp-lextudio: maintained community fork of the abandoned pysnmp library.
# Original pysnmp (<=4.4.12) is unmaintained since 2019.
# Monitor: https://github.com/lextudio/pysnmp for updates.
pysnmp-lextudio==5.0.34
pyasn1==0.4.8
pyasn1-modules==0.2.8
cryptography>=42.0.0
dnspython>=2.6.1
```

---

## Step 2 — `backend/alembic.ini`

Create this file at `backend/alembic.ini`. The `sqlalchemy.url` placeholder is intentionally kept; `env.py` overrides it at runtime via the `DATABASE_URL` environment variable.

```ini
# Alembic configuration file.
# The sqlalchemy.url below is a placeholder only — it is overridden at runtime
# by env.py which reads the DATABASE_URL environment variable.
[alembic]
script_location = /app/alembic
prepend_sys_path = .
file_template = %%(rev)s_%%(slug)s
truncate_slug_length = 40
version_locations = %(here)s/alembic/versions
timezone = UTC

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

**Note on `script_location`:** Set to `/app/alembic` (absolute container path). When alembic is invoked as `alembic -c /app/alembic.ini upgrade head` inside the container, this resolves correctly. `WORKDIR` inside the container is `/app`.

---

## Step 3 — `backend/alembic/env.py`

Create this file at `backend/alembic/env.py`. Write the exact content below verbatim:

```python
"""Alembic environment configuration for switch-map."""
import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

# ---------------------------------------------------------------------------
# Pull the Alembic Config object (gives access to .ini values)
# ---------------------------------------------------------------------------
config = context.config

# Override sqlalchemy.url from environment so the same ini works in Docker
# and in local bare-Python dev.
# Docker sets DATABASE_URL=sqlite:////data/netmap.db (four slashes = absolute path).
# Bare-Python fallback is sqlite:///./netmap.db (relative to cwd).
_db_url = os.environ.get("DATABASE_URL", "sqlite:////data/netmap.db")
config.set_main_option("sqlalchemy.url", _db_url)

# ---------------------------------------------------------------------------
# Logging setup from alembic.ini
# ---------------------------------------------------------------------------
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ---------------------------------------------------------------------------
# Import ALL models so that Base.metadata is fully populated.
# database.py is on sys.path because alembic.ini sets prepend_sys_path = .
# and the container WORKDIR is /app where database.py lives.
# ---------------------------------------------------------------------------
from database import Base  # noqa: E402  — import after path is set up
# Importing database triggers all model class definitions (Rack, Device, etc.)
# No additional imports needed; all models are registered on Base.metadata.

target_metadata = Base.metadata

# ---------------------------------------------------------------------------
# Migration helper functions
# ---------------------------------------------------------------------------

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL to stdout, no DB connection)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,   # Required for SQLite ALTER TABLE support
        compare_type=False,     # Suppress SQLite type-affinity false positives
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (real DB connection)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,   # Required for SQLite ALTER TABLE support
            compare_type=False,     # Suppress SQLite type-affinity false positives
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

---

## Step 4 — `backend/alembic/script.py.mako`

Create this file at `backend/alembic/script.py.mako`. This is the standard Alembic migration template. Write it verbatim:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

# revision identifiers, used by Alembic.
revision: str = ${repr(up_revision)}
down_revision: Union[str, None] = ${repr(down_revision)}
branch_labels: Union[str, Sequence[str], None] = ${repr(branch_labels)}
depends_on: Union[str, Sequence[str], None] = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

---

## Step 5 — `backend/alembic/versions/` directory

Create the directory `backend/alembic/versions/`. This is where all migration revision files live.

Also create `backend/alembic/versions/__init__.py` as an empty file so Python treats it as a package (not strictly required by Alembic but eliminates import edge cases):

```python
```

(empty file)

---

## Step 6 — `backend/alembic/versions/001_initial_schema.py`

Create this file at `backend/alembic/versions/001_initial_schema.py`. This is the hand-written initial migration that captures the full current schema (all 11 tables with all columns). Write it verbatim:

```python
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
```

---

## Step 7 — `backend/database.py`

### What to remove
Delete all seven `_ensure_*` functions entirely:
- `_ensure_device_ping_columns`
- `_ensure_credential_rack_class_columns`
- `_ensure_rack_map_columns`
- `_ensure_scan_run_snapshot_columns`
- `_ensure_port_endpoint_columns`
- `_ensure_app_settings_table`
- `_ensure_device_model_id_column`

### What to change in `create_tables()`
Replace the existing `create_tables()` function (which called all 7 `_ensure_*` functions) with:

1. A new private function `_seed_default_settings()` that handles only the DML (data seeding) that was previously inside `_ensure_app_settings_table()`.
2. A revised `create_tables()` that only calls `Base.metadata.create_all()` (safety net for bare-Python dev) and `_seed_default_settings()`.

### Exact replacement for the bottom of `database.py`

Remove everything from (and including) `def _ensure_device_ping_columns():` to the end of the file, and replace with:

```python
def _seed_default_settings():
    """Insert default app_settings rows if they do not already exist.

    This is pure DML — no DDL. Safe to call every startup because
    INSERT OR IGNORE is a no-op when the row is already present.
    """
    with engine.begin() as conn:
        defaults = [
            ("discovery_interval_sec", "1800"),
            ("port_update_interval_sec", "30"),
            ("discovery_scan_ranges", "[]"),
        ]
        for key, value in defaults:
            conn.execute(
                text("INSERT OR IGNORE INTO app_settings (key, value) VALUES (:key, :value)"),
                {"key": key, "value": value},
            )


def create_tables():
    """Ensure tables exist and seed initial data.

    In Docker deployments the entrypoint runs `alembic upgrade head` before
    uvicorn starts, so by the time this function is called all tables already
    exist and create_all() is a no-op.

    In bare-Python local dev (no Docker, no alembic run) create_all() creates
    the tables from the ORM metadata so the app can start without any migration
    tooling.
    """
    Base.metadata.create_all(bind=engine)
    _seed_default_settings()
```

### Result: the complete bottom section of `database.py` after the last model class

The exact text that should appear after the `ScanRunSwitchMetric` class definition and `scan_run = relationship(...)` line:

```python
def _seed_default_settings():
    """Insert default app_settings rows if they do not already exist.

    This is pure DML — no DDL. Safe to call every startup because
    INSERT OR IGNORE is a no-op when the row is already present.
    """
    with engine.begin() as conn:
        defaults = [
            ("discovery_interval_sec", "1800"),
            ("port_update_interval_sec", "30"),
            ("discovery_scan_ranges", "[]"),
        ]
        for key, value in defaults:
            conn.execute(
                text("INSERT OR IGNORE INTO app_settings (key, value) VALUES (:key, :value)"),
                {"key": key, "value": value},
            )


def create_tables():
    """Ensure tables exist and seed initial data.

    In Docker deployments the entrypoint runs `alembic upgrade head` before
    uvicorn starts, so by the time this function is called all tables already
    exist and create_all() is a no-op.

    In bare-Python local dev (no Docker, no alembic run) create_all() creates
    the tables from the ORM metadata so the app can start without any migration
    tooling.
    """
    Base.metadata.create_all(bind=engine)
    _seed_default_settings()
```

---

## Step 8 — `backend/entrypoint.sh`

Replace the entire file content with the following. The key addition is running Alembic migration before dropping privileges and starting uvicorn.

### Logic
1. `chown`/`chmod` the `/data` volume (same as before — must run as root).
2. Check if the database file already exists AND has user tables but NO `alembic_version` table. If so, this is an existing database being upgraded to Alembic for the first time — stamp it at `head` to mark it as already up-to-date.
3. Run `alembic upgrade head`. For a brand new DB, this creates all tables. For an already-stamped DB, this is a no-op (or applies any pending migrations).
4. `exec gosu appuser uvicorn …` (same as before).

### Exact file content

```sh
#!/bin/sh
# entrypoint.sh — fixes /data ownership for Docker volume mounts, then:
#   1. Runs Alembic migrations (creates or migrates the SQLite schema)
#   2. Drops privileges to appuser
#   3. Starts uvicorn
set -e

chown -R appuser:appuser /data
chmod 700 /data

# ---------------------------------------------------------------------------
# Alembic migration gate
#
# For brand-new databases:  upgrade head creates all tables.
# For databases that existed before Alembic was introduced (no alembic_version
# table but other tables present): stamp head first so Alembic knows the schema
# is already at revision 001, then upgrade head is a no-op.
# ---------------------------------------------------------------------------
DB_PATH=$(python3 -c "
import os
url = os.environ.get('DATABASE_URL', 'sqlite:////data/netmap.db')
# Strip sqlite:/// prefix — handles both relative (./x.db) and absolute (////data/x.db)
path = url.replace('sqlite://', '').lstrip('/')
if not path.startswith('/'):
    path = '/' + path
print(path)
")

if [ -f "$DB_PATH" ]; then
    HAS_ALEMBIC=$(python3 -c "
import sqlite3, sys
try:
    conn = sqlite3.connect('$DB_PATH')
    tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
    conn.close()
    print('yes' if 'alembic_version' in tables else 'no')
except Exception:
    print('yes')  # assume managed, let upgrade handle it
")
    if [ "$HAS_ALEMBIC" = "no" ]; then
        echo "[entrypoint] Existing database detected without alembic_version — stamping at head."
        gosu appuser alembic -c /app/alembic.ini stamp head
    fi
fi

echo "[entrypoint] Running Alembic migrations..."
gosu appuser alembic -c /app/alembic.ini upgrade head

exec gosu appuser "$@"
```

**Why `gosu appuser alembic ...`**: The `/data` directory is now owned by `appuser` (after the `chown` above). Alembic writes to `/data/netmap.db`, so it must run as `appuser`, not root.

---

## Step 9 — `backend/main.py`

No functional changes required. `create_tables()` remains imported and called from `on_startup()`. Its new implementation (Step 7) calls `Base.metadata.create_all()` (no-op after alembic ran) and `_seed_default_settings()` (idempotent INSERT OR IGNORE).

The import line and `on_startup()` body remain exactly as they are:

```python
from database import create_tables, get_db
...
@app.on_event("startup")
def on_startup():
    create_tables()
    threading.Thread(target=_background_scheduler, daemon=True).start()
```

No edit needed to `main.py`.

---

## Step 10 — `backend/Dockerfile`

**No changes required.**

The Dockerfile already contains:
```dockerfile
WORKDIR /app
COPY . .
```

Because `COPY . .` copies everything from the `backend/` build context into `/app/`, the following new files are automatically included in the image without any Dockerfile modification:

| Source (backend/) | Destination in container |
|-------------------|--------------------------|
| `alembic.ini` | `/app/alembic.ini` |
| `alembic/env.py` | `/app/alembic/env.py` |
| `alembic/script.py.mako` | `/app/alembic/script.py.mako` |
| `alembic/versions/001_initial_schema.py` | `/app/alembic/versions/001_initial_schema.py` |

The `alembic -c /app/alembic.ini upgrade head` command in `entrypoint.sh` will therefore find both the ini file and the `script_location = /app/alembic` directory.

---

## Final File Tree (backend/)

```
backend/
├── alembic.ini                          ← NEW
├── alembic/
│   ├── env.py                           ← NEW
│   ├── script.py.mako                   ← NEW
│   └── versions/
│       ├── __init__.py                  ← NEW (empty)
│       └── 001_initial_schema.py        ← NEW
├── database.py                          ← MODIFIED (remove 7 _ensure_* fns, simplify create_tables)
├── Dockerfile                           ← unchanged
├── entrypoint.sh                        ← MODIFIED (add alembic stamp/upgrade before exec)
├── main.py                              ← unchanged
└── requirements.txt                     ← MODIFIED (add alembic==1.13.3)
```

---

## Execution Order at Container Startup

```
entrypoint.sh (root)
  chown -R appuser:appuser /data          # fix volume ownership
  chmod 700 /data
  [detect existing DB without alembic_version]
    → gosu appuser alembic stamp head     # only if upgrading from pre-alembic DB
  gosu appuser alembic upgrade head       # create tables OR apply pending migrations
  exec gosu appuser uvicorn main:app …    # start FastAPI

on_startup() (in uvicorn process, as appuser)
  create_tables()
    Base.metadata.create_all()            # no-op: tables exist from alembic
    _seed_default_settings()              # INSERT OR IGNORE 3 default app_settings rows
  threading.Thread(_background_scheduler).start()
```

---

## Notes and Edge Cases

### Bare-Python Local Dev (no Docker)
Running `python -m uvicorn main:app` without Docker and without running `alembic upgrade head` manually:
- `DATABASE_URL` defaults to `sqlite:///./netmap.db`
- `create_tables()` calls `Base.metadata.create_all()` which creates all tables from scratch
- `_seed_default_settings()` inserts default app_settings rows
- Works identically to the pre-Alembic behavior

### Future Migrations
To add a new column or table:
1. Create a new file `backend/alembic/versions/002_description.py`
2. Set `revision = "002"`, `down_revision = "001"`
3. Write `upgrade()` and `downgrade()` using `op.add_column()`, `op.create_table()`, etc.
4. Rebuild the Docker image — `alembic upgrade head` in `entrypoint.sh` applies it automatically

### `alembic_version` Table
Alembic automatically creates and manages the `alembic_version` table. It contains a single row with the current revision ID. Never manually edit this table.

### `render_as_batch=True`
This is set in both `run_migrations_offline()` and `run_migrations_online()` in `env.py`. It is required for SQLite because SQLite does not support `ALTER TABLE ... DROP COLUMN`, `ALTER TABLE ... ALTER COLUMN`, or multi-column constraint changes. Batch mode works by creating a new table, copying data, dropping the old table, and renaming — all transparently.
