# Version History

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
