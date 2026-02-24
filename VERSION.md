# Version History

## v1.3.1 — Rack Detail Reorder Fix

**Type:** PATCH (bug fix)

### Changes

#### Rack Detail: Switch Reorder Buttons
- Fixed non-functional reorder behavior in rack detail panel (`^` / `v`) caused by ID type mismatches (`number` vs `string`) in localStorage order comparisons.
- `frontend/src/hooks/useRackOrders.js`: normalized all compared/stored device IDs via `String(id)` and added a safe guard for missing `selectedRack.devices`.
- `frontend/src/components/map/RackDetail.jsx`: normalized `deviceOrder` IDs to strings before sorting, so persisted order is applied reliably.

### Files Modified
| File | Change |
|------|--------|
| frontend/src/hooks/useRackOrders.js | Normalize reorder IDs and guard missing devices |
| frontend/src/components/map/RackDetail.jsx | Normalize sort comparison IDs |

---

## v1.3.0 — PostgreSQL Migration + Device Ignore Flag

**Type:** MINOR (new infrastructure + new feature)

### Changes

#### PostgreSQL Migration
- Replaced SQLite with PostgreSQL 16-alpine for improved concurrency and write performance.
- `docker-compose.yml`: added `postgres:16-alpine` service with TCP healthcheck and `netmap-pgdata` named volume.
- `backend/database.py`: PostgreSQL engine with connection pooling (`pool_size=10`, `max_overflow=20`, `pool_pre_ping=True`, `pool_recycle=300`). Fixed `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (key) DO NOTHING` for PostgreSQL compatibility.
- `backend/requirements.txt`: `psycopg2-binary>=2.9.9` added.
- `backend/Dockerfile`: `libpq5` runtime dependency added; removed SQLite `DATABASE_URL` ENV default.
- `backend/entrypoint.sh`: replaced SQLite stamp-head detection with PostgreSQL TCP readiness wait loop (up to 60 seconds on port 5432).
- `backend/alembic/env.py`: removed SQLite-only `render_as_batch=True` and `compare_type=False` workarounds.
- `backend/alembic/versions/002_add_device_ignored.py`: `server_default="false"` (was `"0"` for SQLite Boolean).
- `backend/scan_engine.py`: port inserts use `bulk_insert_mappings` instead of individual `db.add()` calls.
- `migrate_sqlite_to_pg.py`: one-shot data migration script (SQLite → PostgreSQL, column-for-column copy with boolean casting and sequence reset).

#### Device Ignore Flag
- Added `ignored BOOLEAN NOT NULL DEFAULT false` column to `devices` table via Alembic migration `002`.
- `GET /api/topology`: filters out ignored devices (`Device.ignored == False`).
- `GET /api/devices`: new endpoint returning all devices including ignored ones.
- `PATCH /api/devices/{id}/meta`: supports `ignored` field.
- `CredentialsTab.jsx`: shows "ignored" badge per device row; Ignore/Re-enable button per row.

#### Assign Dropdown Fixes
- ETag cache invalidation (`api.invalidate()`) called before `refreshAll()` after assign/unassign in settings tabs.
- Assign dropdowns: only show unassigned devices with `ports.length > 0` (successfully scanned).

### Files Modified
| File | Change |
|------|--------|
| docker-compose.yml | PostgreSQL service, pgdata volume |
| backend/database.py | PostgreSQL engine, connection pooling, INSERT ON CONFLICT fix |
| backend/requirements.txt | psycopg2-binary |
| backend/Dockerfile | libpq5, remove SQLite ENV |
| backend/entrypoint.sh | PostgreSQL readiness wait |
| backend/alembic/env.py | Remove SQLite workarounds |
| backend/alembic/versions/002_add_device_ignored.py | NEW — devices.ignored column |
| backend/scan_engine.py | bulk_insert_mappings for ports |
| backend/routers/topology.py | Filter ignored devices; GET /api/devices endpoint |
| frontend/src/api.js | api.invalidate() method |
| frontend/src/components/settings/CredentialsTab.jsx | Ignore/Re-enable button, ignored badge |
| migrate_sqlite_to_pg.py | NEW — one-shot SQLite→PostgreSQL data migration |

---

## v1.2.1 — SNMP Scanner Fix + Topology Map Rendering Fixes

**Type:** PATCH (critical bug fixes)

### Changes

#### Backend: pysnmp-lextudio 5.x API Fix
- Fixed `snmp_bulk_walk` in `backend/snmp_scanner.py`: pysnmp-lextudio 5.x changed `bulkCmd` from an async iterator to a single awaitable Future. Rewrote the function to use a manual loop with repeated `await bulkCmd(...)` calls.
- Fixed `var_binds` indexing: in v5.x each element of `var_binds` is `[ObjectType]` (a single-element list), not `ObjectType` directly. Added `vb = row[0] if isinstance(row, (list, tuple)) else row` unwrap in both `snmp_bulk_walk` and `snmp_get`.
- Result: All 25 switches now return correct interface counts (e.g. 67 ifaces, 2 LLDP nbrs) and 907+ ports are populated in the database.

#### Frontend: Topology Map Port/Link Display Fixes
- `api.js`: Added `normPort()` export for case/whitespace-normalised port name comparison. Used in `buildPortLinkMap`. Added `structuredClone` for ETag cache to prevent reference aliasing.
- `SwitchPanel.jsx`, `Port.jsx`, `RackDetail.jsx`: Import and use `normPort()` in all port key constructions.
- `MapPage.jsx`: Added `selectedRackFull` memo so `RackDetail` always receives a fully-populated device list even after device moves.
- `TopologyMap.jsx`: Build `ipToRackId` map from unfiltered nodes + managedRacks. Added null guards for `onMouseUp` and `d.ports`.
- `useTopologyData.js`: Simplified `loadTopology` to prevent stale-device sync issues.

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Rewritten `snmp_bulk_walk` (manual loop); fixed `var_binds` indexing in `snmp_get` |
| backend/scan_engine.py | `remote_port` normalization: suffix-based matching resolves LLDP abbreviations to canonical `if_descr` |
| frontend/src/api.js | `normPort()` export; `structuredClone` ETag cache |
| frontend/src/hooks/useTopologyData.js | Simplified `loadTopology` |
| frontend/src/components/SwitchPanel.jsx | `normPort` in pKey |
| frontend/src/components/Port.jsx | `normPort` in highlight keys |
| frontend/src/components/map/RackDetail.jsx | `normPort` in `useEffect` for dotted-line lookup; unclassified links shown as uplinks |
| frontend/src/pages/MapPage.jsx | `selectedRackFull` memo |
| frontend/src/components/map/TopologyMap.jsx | `ipToRackId` from unfiltered nodes + guards |

---

## v1.2.0 — Frontend Split + Alembic Migrations

**Type:** MINOR (structural refactoring + new migration framework)

### Changes
- Split `frontend/src/pages/SettingsPage.jsx` (2149 lines) into 9 focused tab components in `frontend/src/components/settings/`.
- Split `frontend/src/pages/MapPage.jsx` (1126 lines) into 4 sub-components and 3 custom hooks.
  - New components: `TopologyMap`, `RackDetail`, `FilterBar`, `ActiveLinkBar` in `frontend/src/components/map/`.
  - New hooks: `useTopologyData`, `useMapBackground`, `useRackOrders` in `frontend/src/hooks/`.
- Added **Alembic** database migration framework (`alembic==1.13.3`).
  - `backend/alembic/` directory with `env.py` (SQLite batch mode), `script.py.mako`, and `versions/001_initial_schema.py` (all 11 tables).
  - `entrypoint.sh` auto-detects pre-Alembic databases, stamps them at head, then runs `alembic upgrade head` on every container start.
  - All 7 ad-hoc `_ensure_*` DDL functions removed from `database.py` and replaced by proper migrations.
  - `_seed_default_settings()` preserved for idempotent `app_settings` row seeding.
- Verified: all 12 API endpoints return 200 after all changes.

### Files Created/Modified
| File | Change |
|------|--------|
| frontend/src/components/settings/ (9 files) | NEW — tab components extracted from SettingsPage.jsx |
| frontend/src/pages/SettingsPage.jsx | 2149 lines → ~100 lines |
| frontend/src/components/map/ (4 files) | NEW — sub-components extracted from MapPage.jsx |
| frontend/src/hooks/ (3 files) | NEW — custom hooks extracted from MapPage.jsx |
| frontend/src/pages/MapPage.jsx | 1126 lines → 146 lines |
| backend/alembic.ini | NEW |
| backend/alembic/env.py | NEW |
| backend/alembic/script.py.mako | NEW |
| backend/alembic/versions/001_initial_schema.py | NEW |
| backend/database.py | Removed 7 _ensure_* functions, added _seed_default_settings() |
| backend/entrypoint.sh | Added alembic stamp + upgrade head logic |
| backend/requirements.txt | Added alembic==1.13.3 |

---

## v1.1.0 — Backend Router Split Refactoring

**Type:** MINOR (structural refactoring — no API surface changes)

### Changes
- Split `backend/main.py` (2123 lines) into a clean router-based structure.
- New thin `backend/main.py` (53 lines): app factory and wiring only.
- New `backend/scan_engine.py` (968 lines): all scan engine logic, background scheduler, ping/DNS helpers, job management.
- New `backend/shared/state.py`: `LOG_BUFFER`, `SCAN_JOBS`, `_log_event()`.
- New `backend/shared/auth.py`: `SECRET_TOKEN`, `_bearer`, `_require_auth()`.
- New `backend/shared/file_settings.py`: all file-system constants and read/write helpers for map, scan, and DNS settings.
- New `backend/routers/` package (15 router files): `health`, `settings`, `credentials`, `snmp_profiles`, `racks`, `switch_classes`, `switch_models`, `scan`, `scan_runs`, `topology`, `map_bg`, `scan_settings`, `bulk`, `config`, `logs`.
- All route handler logic copied verbatim — no functional changes.
- All API endpoints verified 200 OK after refactoring via Docker smoke test.

### Files Created/Modified
| Lines | File |
|------:|------|
| 53 | backend/main.py |
| 968 | backend/scan_engine.py |
| 137 | backend/shared/file_settings.py |
| 31 | backend/shared/state.py |
| 19 | backend/shared/auth.py |
| 0 | backend/shared/__init__.py |
| 207 | backend/routers/bulk.py |
| 160 | backend/routers/config.py |
| 121 | backend/routers/topology.py |
| 83 | backend/routers/scan_settings.py |
| 81 | backend/routers/map_bg.py |
| 66 | backend/routers/credentials.py |
| 62 | backend/routers/scan.py |
| 58 | backend/routers/scan_runs.py |
| 54 | backend/routers/snmp_profiles.py |
| 48 | backend/routers/racks.py |
| 48 | backend/routers/switch_classes.py |
| 48 | backend/routers/switch_models.py |
| 47 | backend/routers/settings.py |
| 29 | backend/routers/logs.py |
| 9 | backend/routers/health.py |
| 0 | backend/routers/__init__.py |

---

## v1.0.0 — Initial Release

- Monolithic `backend/main.py` (2123 lines) FastAPI application.
- SNMP-based network topology discovery and mapping.
- Frontend React/Vite SPA served via Nginx.
- SQLite database via SQLAlchemy.
- Docker Compose deployment.
