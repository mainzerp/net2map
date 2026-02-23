# Alembic Integration Analysis

## 1. SQLAlchemy Models (Full Column Inventory)

### `Rack` — table: `racks`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| label | String | NOT NULL |
| room | String | default="" |
| description | String | default="" |
| map_x | Float | default=100.0 |
| map_y | Float | default=100.0 |
| created_at | DateTime | default=utcnow |
| updated_at | DateTime | default=utcnow, onupdate=utcnow |

### `SwitchClass` — table: `switch_classes`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| label | String | NOT NULL |
| description | String | default="" |
| color | String | default="#64748b" |
| created_at | DateTime | default=utcnow |
| updated_at | DateTime | default=utcnow, onupdate=utcnow |

### `SwitchModel` — table: `switch_models`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| name | String | NOT NULL, UNIQUE |
| ports_per_row | Integer | default=24 |
| total_ports | Integer | nullable=True |
| description | String | default="" |
| created_at | DateTime | default=utcnow |
| updated_at | DateTime | default=utcnow, onupdate=utcnow |

### `SnmpProfile` — table: `snmp_profiles`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| label | String | NOT NULL |
| snmp_version | String | default="v2c" |
| community | String | default="public" |
| v3_security_level | String | default="authPriv" |
| v3_username | String | default="" |
| v3_auth_protocol | String | default="SHA-256" |
| v3_auth_password | String | default="" |
| v3_priv_protocol | String | default="AES-128" |
| v3_priv_password | String | default="" |
| created_at | DateTime | default=utcnow |
| updated_at | DateTime | default=utcnow, onupdate=utcnow |

### `Credential` — table: `credentials`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| label | String | NOT NULL |
| ip | String | NOT NULL, UNIQUE |
| snmp_port | Integer | default=161 |
| location | String | default="" |
| enabled | Boolean | default=True |
| snmp_version | String | default="v2c" |
| community | String | default="public" |
| v3_security_level | String | default="authPriv" |
| v3_username | String | default="" |
| v3_auth_protocol | String | default="SHA-256" |
| v3_auth_password | String | default="" |
| v3_priv_protocol | String | default="AES-128" |
| v3_priv_password | String | default="" |
| profile_id | Integer | FK→snmp_profiles.id, nullable |
| rack_id | Integer | FK→racks.id, nullable |
| class_id | Integer | FK→switch_classes.id, nullable |
| vendor | String | default="" |
| model | String | default="" |
| created_at | DateTime | default=utcnow |
| updated_at | DateTime | default=utcnow, onupdate=utcnow |

### `Device` — table: `devices`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| sys_name | String | index=True |
| ip | String | NOT NULL, UNIQUE, index |
| sys_descr | Text | default="" |
| model | String | default="" |
| vendor | String | default="" |
| location | String | default="" |
| ping_status | String | default="unknown" |
| ping_rtt_ms | Integer | default=0 |
| last_ping | DateTime | nullable=True |
| map_x | Float | default=100.0 |
| map_y | Float | default=100.0 |
| last_seen | DateTime | default=utcnow |
| rack_id | Integer | FK→racks.id, nullable |
| class_id | Integer | FK→switch_classes.id, nullable |
| model_id | Integer | FK→switch_models.id, nullable |

### `Port` — table: `ports`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| device_id | Integer | FK→devices.id, NOT NULL, index |
| if_index | Integer | NOT NULL |
| if_descr | String | default="" |
| if_alias | String | default="" |
| speed_mbps | Integer | default=0 |
| oper_status | Integer | default=2 |
| peer_mac | String | default="" |
| peer_ip | String | default="" |
| peer_host | String | default="" |
| endpoint_count | Integer | default=0 |
| endpoint_details_json | Text | default="[]" |
| vlan | Integer | default=0 |

### `TopologyLink` — table: `topology_links`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| local_ip | String | NOT NULL |
| local_port | String | default="" |
| remote_ip | String | default="" |
| remote_sys | String | default="" |
| remote_port | String | default="" |
| speed_label | String | default="1G" |
| discovered_at | DateTime | default=utcnow |

### `AppSetting` — table: `app_settings`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| key | String | PK, index |
| value | String | NOT NULL |

Default seed rows (inserted on startup):
- `discovery_interval_sec` = "1800"
- `port_update_interval_sec` = "30"
- `discovery_scan_ranges` = "[]"

### `ScanRun` — table: `scan_runs`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| status | String | default="finished" |
| scanned | Integer | default=0 |
| found | Integer | default=0 |
| links | Integer | default=0 |
| max_workers | Integer | default=1 |
| total_duration_ms | Integer | default=0 |
| error_count | Integer | default=0 |
| devices_snapshot_json | Text | default="[]" |
| links_snapshot_json | Text | default="[]" |
| created_at | DateTime | default=utcnow |

### `ScanRunSwitchMetric` — table: `scan_run_switch_metrics`
| Column | Type | Constraints / Defaults |
|--------|------|------------------------|
| id | Integer | PK, index |
| scan_run_id | Integer | FK→scan_runs.id, NOT NULL, index |
| ip | String | default="" |
| label | String | default="" |
| duration_ms | Integer | default=0 |
| success | Boolean | default=False |
| error | Text | default="" |

---

## 2. All `_ensure_*` Functions

These are the hand-rolled migration shims that exist because the codebase has never used a migration tool. All of them:
- Guard on `conn.dialect.name != "sqlite"` (no-op on non-SQLite)
- Use `PRAGMA table_info(table_name)` to detect missing columns
- Emit `ALTER TABLE … ADD COLUMN` via `text()` with hardcoded SQL fragments

| Function | Table | Columns Added |
|----------|-------|---------------|
| `_ensure_device_ping_columns` | `devices` | `ping_status VARCHAR DEFAULT 'unknown'`, `ping_rtt_ms INTEGER DEFAULT 0`, `last_ping DATETIME` |
| `_ensure_credential_rack_class_columns` | `credentials` | `rack_id INTEGER`, `class_id INTEGER`, `vendor VARCHAR DEFAULT ''`, `model VARCHAR DEFAULT ''` |
| `_ensure_rack_map_columns` | `racks` | `map_x FLOAT DEFAULT 100.0`, `map_y FLOAT DEFAULT 100.0` |
| `_ensure_scan_run_snapshot_columns` | `scan_runs` | `devices_snapshot_json TEXT DEFAULT '[]'`, `links_snapshot_json TEXT DEFAULT '[]'` |
| `_ensure_port_endpoint_columns` | `ports` | `endpoint_count INTEGER DEFAULT 0`, `endpoint_details_json TEXT DEFAULT '[]'` |
| `_ensure_app_settings_table` | `app_settings` | Creates table with `CREATE TABLE IF NOT EXISTS` + inserts three default rows |
| `_ensure_device_model_id_column` | `devices` | `model_id INTEGER REFERENCES switch_models(id)` |

All seven are called sequentially from `create_tables()` in `database.py`.

---

## 3. DATABASE_URL

```python
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./netmap.db")
```

- **Default (bare Python):** `sqlite:///./netmap.db` — resolves to `netmap.db` in the working directory.
- **In Docker:** the `docker-compose.yml` volume mounts `/data/` into the container, so `DATABASE_URL` must be set to `sqlite:////data/netmap.db` (four slashes = absolute path).
- **Alembic `alembic.ini`** must use the same absolute path or read from an environment variable so it finds the correct file when run from inside the container or alongside it.

Recommended `alembic.ini` value:
```ini
sqlalchemy.url = sqlite:////data/netmap.db
```
Or, better, leave the ini placeholder and override in `env.py`:
```python
config.set_main_option("sqlalchemy.url", os.environ.get("DATABASE_URL", "sqlite:////data/netmap.db"))
```

---

## 4. Startup Flow — How the DB is Initialized

```
uvicorn main:app (startup)
  └─ on_startup()                       [main.py]
       └─ create_tables()               [database.py]
            ├─ Base.metadata.create_all(bind=engine)   # creates all ORM-mapped tables
            ├─ _ensure_app_settings_table()
            ├─ _ensure_device_ping_columns()
            ├─ _ensure_credential_rack_class_columns()
            ├─ _ensure_rack_map_columns()
            ├─ _ensure_scan_run_snapshot_columns()
            ├─ _ensure_port_endpoint_columns()
            └─ _ensure_device_model_id_column()
```

`create_all()` creates tables that do not yet exist. The `_ensure_*` chain then adds columns
that were backfilled onto already-existing tables. There is no transactional ordering guarantee
between `create_all` and the ALTER TABLE calls; if the process crashes mid-sequence, a partial
schema state can result (mitigated by the idempotent `IF NOT EXISTS` / PRAGMA checks, but not
atomically safe).

---

## 5. Existing Schema Version Tracking

**None.** There is no `alembic_version` table, no `schema_version` column, and no version record
of any kind. Every upgrade to date has been accomplished by adding a new `_ensure_*` function.

---

## 6. Raw DDL Locations

All raw DDL is confined to `database.py`:

| Location | SQL |
|----------|-----|
| `_ensure_device_ping_columns` | `ALTER TABLE devices ADD COLUMN …` ×3 |
| `_ensure_credential_rack_class_columns` | `ALTER TABLE credentials ADD COLUMN …` ×4 |
| `_ensure_rack_map_columns` | `ALTER TABLE racks ADD COLUMN …` ×2 |
| `_ensure_scan_run_snapshot_columns` | `ALTER TABLE scan_runs ADD COLUMN …` ×2 |
| `_ensure_port_endpoint_columns` | `ALTER TABLE ports ADD COLUMN …` ×2 |
| `_ensure_app_settings_table` | `CREATE TABLE IF NOT EXISTS app_settings …` |
| `_ensure_device_model_id_column` | `ALTER TABLE devices ADD COLUMN model_id …` |

No other file contains DDL. The routers only issue DML (SELECT/INSERT/UPDATE/DELETE).

---

## 7. Risk Areas

### 7.1 Columns Added Dynamically via `_ensure_*`
Each `_ensure_*` function adds columns that are **already declared in the ORM models**.
`create_all()` would have created them on a fresh DB. On an existing DB the `_ensure_*`
functions fill the gap. This means:

- **SQLite type mismatches are silent.** SQLite stores `FLOAT` as `REAL` and `VARCHAR` as `TEXT`.
  Alembic autogenerate will flag these as differences unless `compare_type=False` is used.
- **DEFAULT values in SQLite ALTER TABLE are baked into the column metadata**, not enforced
  by the engine; Python-side defaults in the ORM may diverge from the SQLite column default.
- All seven functions carry a SQLite-only guard, so they are dead code on PostgreSQL/MySQL.

### 7.2 Race Condition at Startup
`create_tables()` is called during `on_event("startup")` which runs in a single async context,
but multiple Uvicorn workers could start simultaneously. Two workers calling `create_all()` at
the same moment is safe because SQLAlchemy wraps DDL in transactions, but two workers
calling `_ensure_*` at the same moment could hit a SQLITE_BUSY (mitigated by `PRAGMA busy_timeout=10000`).
With WAL mode this is very unlikely to cause data loss, but it could cause a startup delay.

### 7.3 No Rollback Capability
The `_ensure_*` pattern has no down-migration. Once a column is added there is no path to
remove it. Alembic provides `downgrade()` functions.

### 7.4 `_ensure_app_settings_table` Is Both DDL and DML
This function creates the table AND inserts default rows. Alembic migrations should only contain
DDL. The data seeding should be moved to a separate `seed_db.py` step or kept as a runtime
check in application code.

---

## 8. Recommended Approach

### Use Alembic Autogenerate for the Initial Migration, Then Hand-Write Future Ones

**Rationale:**
- The schema is moderately complex (11 tables, ~90 columns total) — autogenerate produces
  a correct initial migration faster than hand-writing.
- Future migrations for small changes (add column, add index) should be hand-written or
  autogenerated from model changes; the generated SQL should always be reviewed before commit.
- SQLite does NOT support `ALTER TABLE … DROP COLUMN` in older versions (< 3.35) or `ALTER TABLE … ALTER COLUMN`.
  For any destructive migration on SQLite a table-recreation strategy is needed; Alembic's
  `render_as_batch=True` (batch mode) handles this automatically.

**Set `render_as_batch=True` in `env.py`** — this is mandatory for SQLite.

---

## 9. What to Keep in `database.py` vs What to Remove

### Keep
- `DATABASE_URL` constant
- `engine` creation (including WAL-mode connect event listener)
- `SessionLocal` and `Base`
- `get_db()` dependency
- All ORM model class definitions (`Rack`, `SwitchClass`, etc.)

### Remove (after Alembic migrations cover the same ground)
- `_ensure_device_ping_columns()`
- `_ensure_credential_rack_class_columns()`
- `_ensure_rack_map_columns()`
- `_ensure_scan_run_snapshot_columns()`
- `_ensure_port_endpoint_columns()`
- `_ensure_device_model_id_column()`
- The `CREATE TABLE IF NOT EXISTS app_settings` block inside `_ensure_app_settings_table()`
  (keep the default-row insertion logic, but move it to `seed_db.py` or a startup check that
  does NOT issue DDL)
- `create_tables()` function (replace with `alembic upgrade head` in `entrypoint.sh`)

### Modify
- `main.py` `on_startup`: remove the `create_tables()` call; Alembic upgrades will happen via
  `entrypoint.sh` before the process starts, not at application startup.

---

## 10. Alembic `alembic.ini` DATABASE_URL Plan

The SQLite file lives at `/data/netmap.db` inside the container (volume mount).

**`alembic.ini`** — set a placeholder:
```ini
[alembic]
script_location = alembic
sqlalchemy.url = sqlite:////data/netmap.db
```

**`alembic/env.py`** — override from environment so local development also works:
```python
import os
from alembic import context
from database import Base, DATABASE_URL

config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)
target_metadata = Base.metadata
```

**`backend/entrypoint.sh`** — run upgrade before starting the server:
```sh
#!/bin/sh
set -e
alembic upgrade head
exec uvicorn main:app --host 0.0.0.0 --port 8000
```

This ensures the database is always migrated to the latest revision before any API request
is served, eliminating the startup-race risk.

---

## 11. Files to Create / Touch

| Path | Action |
|------|--------|
| `backend/alembic.ini` | Create — standard Alembic config pointing to `/data/netmap.db` |
| `backend/alembic/env.py` | Create — reads `DATABASE_URL` from environment, sets `render_as_batch=True`, targets `Base.metadata` |
| `backend/alembic/versions/0001_initial_schema.py` | Create — autogenerated initial migration representing the full current schema |
| `backend/database.py` | Modify — remove all `_ensure_*` functions and `create_tables()` |
| `backend/main.py` | Modify — remove `create_tables()` call from `on_startup` |
| `backend/entrypoint.sh` | Modify — prepend `alembic upgrade head` |
| `backend/requirements.txt` | Modify — add `alembic>=1.13` |

---

## Summary

The project has **11 ORM models** across 11 tables. Schema evolution has been handled by **7 hand-rolled `_ensure_*` shims** that fire `ALTER TABLE` raw DDL at every startup. There is **no schema version tracking**. The DATABASE_URL is environment-configurable; in Docker it resolves to `/data/netmap.db`.

The recommended path to Alembic is:
1. Install Alembic, init the `alembic/` directory inside `backend/`.
2. Configure `env.py` with `render_as_batch=True` (required for SQLite) and point it at `Base.metadata`.
3. Generate a single initial migration (`alembic revision --autogenerate -m "initial_schema"`), review it, and stamp any existing databases with `alembic stamp head`.
4. Remove all `_ensure_*` functions and `create_tables()` from `database.py`.
5. Update `entrypoint.sh` to call `alembic upgrade head` before starting Uvicorn.
