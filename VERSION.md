# Version History

## v1.11.0 — Slide-In Switch Detail Panel

**Type:** MINOR (new feature)

### Changes

#### Slide-In Switch Detail Panel
- Switch detail view converted from separate page route to slide-in panel overlay on map.
- [i] button color fixed for visibility (#475569 -> #94a3b8, border #1e293b -> #334155).
- Removed /switch/:id route and deleted SwitchDetailPage.jsx.
- Panel slides in from the right with backdrop overlay and CSS animation.
- Sortable 9-column port table preserved from previous implementation.

### Files Created
| File | Description |
|------|-------------|
| frontend/src/components/SwitchDetailSlideIn.jsx | Slide-in panel component with sortable port table |

### Files Modified
| File | Change |
|------|--------|
| frontend/src/pages/MapPage.jsx | Added detailSwitchId state, import, render of SwitchDetailSlideIn, pass onShowDetail to RackDetail |
| frontend/src/components/map/RackDetail.jsx | Accept and thread onShowDetail prop to SwitchPanel |
| frontend/src/components/SwitchPanel.jsx | Replaced useNavigate with onShowDetail callback, fixed [i] button color |
| frontend/src/main.jsx | Removed SwitchDetailPage import and /switch/:id route |

### Files Deleted
| File | Reason |
|------|--------|
| frontend/src/pages/SwitchDetailPage.jsx | Replaced by SwitchDetailSlideIn component |

---

## v1.10.0 — Switch Detail Page

**Type:** MINOR (new feature, superseded by v1.11.0)

### Changes

#### Per-Switch Detail Page
- New `/switch/:id` route with full port table for any switch, accessible via `[i]` button on each switch panel in the rack overview.
- Switch header card showing name, IP, vendor, model, location, ping status, RTT, and active port count.
- Sortable 9-column port table: port number, name, status, speed, native VLAN, tagged VLANs, MAC address, IP, hostname.
- Loading state when topology is not yet fetched (auto-loads on direct URL navigation).
- Not-found state with back button when device ID is invalid.
- Dark theme matching existing style tokens.

### Files Created
| File | Description |
|------|-------------|
| frontend/src/pages/SwitchDetailPage.jsx | Full switch detail page with sortable port table |

### Files Modified
| File | Change |
|------|--------|
| frontend/src/main.jsx | Added SwitchDetailPage import and `/switch/:id` route inside App layout |
| frontend/src/components/SwitchPanel.jsx | Added `[i]` details button with useNavigate to `/switch/:id` |

---

## v1.9.0 — Tagged VLAN Collection

**Type:** MINOR (new feature)

### Changes

#### Tagged VLAN Support
- Added SNMP collection of tagged (trunked) VLAN memberships per port using Q-BRIDGE-MIB bitmask OIDs (`dot1qVlanStaticEgressPorts` / `dot1qVlanStaticUntaggedPorts`).
- New `snmp_bulk_walk_raw()` function for binary OCTET STRING bitmask data (preserves raw bytes instead of decoding to string).
- New `parse_port_bitmask()` helper to convert Q-BRIDGE port bitmasks into sets of bridge port numbers.
- Tagged VLANs computed as `EgressPorts - UntaggedPorts` per VLAN, mapped back to ifIndex via bridge port table.
- Two bitmask walks executed in parallel via `asyncio.gather` for performance.
- Graceful fallback: tagged VLAN walk failure does not break existing PVID collection.
- `tagged_vlans` JSONB column added to `ports` table (Alembic migration 011).
- `tagged_vlans` field added to `IfInfo` dataclass, `PortOut` schema, and scan engine port persistence.
- Frontend: port tooltip and detail modal now display tagged VLANs alongside native VLAN.

### Files Created
| File | Description |
|------|-------------|
| backend/alembic/versions/011_add_tagged_vlans.py | Migration adding tagged_vlans JSONB column to ports |

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Added OID constants, snmp_bulk_walk_raw(), parse_port_bitmask(), tagged_vlans field on IfInfo, step 6b tagged VLAN collection |
| backend/database.py | Added tagged_vlans JSONB column to Port model |
| backend/scan_engine.py | Added tagged_vlans to port_rows persistence |
| backend/schemas.py | Added tagged_vlans to PortOut schema with null coercion |
| frontend/src/components/Port.jsx | Added tagged VLANs display in tooltip |
| frontend/src/components/PortDetailModal.jsx | Added tagged VLANs row in detail modal |

---

## v1.8.1 — Alembic Migration Fixes + Map Background Upload

**Type:** PATCH (bug fixes)

### Changes

#### Alembic Migration Chain Repair
- Fixed duplicate revision ID "003" that caused `alembic upgrade head` to fail with "Multiple head revisions". Renumbered `003_add_switch_class_allow_outside_rack.py` to `003b` and chained it after the cascade migration.
- Added `ondelete="CASCADE"` to `dry_run_results.scan_run_id` FK (model + new migration 010) to prevent IntegrityError when deleting scan runs.
- Fixed `scan_max_workers` seed value from '4' to '12' in migration 005 to match database.py.
- Added `compare_type=True` to `alembic/env.py` for better autogenerate column type detection.
- Corrected impossible date metadata in migration docstrings (003, 004, 005).

#### Map Background Upload Fix
- Fixed auth token not being sent on upload: replaced broken `import.meta.env.VITE_API_TOKEN` with shared `_getAuthHeader()` reading from localStorage (same pattern as all other API calls).
- Added `client_max_body_size 25m` to nginx `/api/` location block (default 1 MB was blocking uploads).
- Added error handling: upload failures now show error detail via alert instead of silently ignoring.
- Added `/api/map-background` to auth-exempt paths so browser-native `<image>` requests can load the background without auth headers (POST/DELETE remain role-guarded).

### Files Created
| File | Description |
|------|-------------|
| backend/alembic/versions/010_dry_run_cascade.py | Migration adding CASCADE to dry_run_results FK |

### Files Modified
| File | Change |
|------|--------|
| backend/alembic/versions/003b_add_switch_class_allow_outside_rack.py | Renamed from 003, updated revision chain |
| backend/alembic/versions/004_jsonb_snapshot_columns.py | Updated down_revision to "003b" |
| backend/alembic/versions/005_settings_to_db.py | Fixed scan_max_workers seed, date |
| backend/alembic/versions/003_add_cascade_deletes.py | Fixed docstring date |
| backend/alembic/env.py | Added compare_type=True |
| backend/database.py | Added ondelete="CASCADE" to DryRunResult FK |
| backend/shared/auth.py | Added /api/map-background to auth-exempt paths |
| frontend/src/api.js | Exported _getAuthHeader() |
| frontend/src/pages/SettingsPage.jsx | Fixed upload auth + error handling |
| frontend/nginx.conf | Added client_max_body_size 25m |

---

## v1.8.0 — Port Endpoint Data (MAC/IP on Hover)

**Type:** MINOR (new feature)

### Changes

#### Port Endpoint Data Population
- **MAC-only endpoints**: Ports now show MAC addresses even when no IP is available (FDB data without ARP).
- **Global ARP table**: ARP tables from all scanned devices (especially routers) are merged and shared across L2 switches, enabling IP resolution for MACs on pure L2 switches.
- **IP-MIB unified fallback**: When legacy ARP table (ipNetToMediaTable) returns empty, the scanner falls back to the unified IP-MIB neighbor table (ipNetToPhysicalPhysAddress). Resolves ARP for OPNsense/FreeBSD and modern devices.
- **LLDP port filtering**: MAC-only entries are skipped on ports with LLDP neighbors (interswitch/uplink links) to avoid transit MAC noise.
- **Diagnostic logging**: SNMP walk result counts (ARP MAC/IP, bridge port, FDB rows) and final endpoint table sizes are logged for each device.
- **Smart sorting**: When multiple endpoints exist on a port, entries with IPs sort first for primary display.

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Diagnostic logging after ARP/FDB walks, IP-MIB unified neighbor table fallback |
| backend/scan_engine.py | MAC-only endpoint loop, LLDP port filtering, global ARP merge, updated sort key |

---

## v1.7.0 — Phase 6 & 7: Observability, Operations, and Remaining Items

**Type:** MINOR (new features + infrastructure)

### Changes

#### 6.1 Prometheus Metrics
- Added `prometheus-client>=0.20.0` to requirements.txt.
- Created `backend/shared/metrics.py` with Histogram, Counter, and Gauge metrics for scans, devices, ports, and HTTP requests.
- Added `MetricsMiddleware` to `main.py` recording request latency and total counts per method/endpoint/status (excludes /metrics itself).
- Added `GET /metrics` endpoint (auth-exempt, excluded from schema) returning Prometheus text format.
- Instrumented `scan_engine.py`: SCAN_ACTIVE inc/dec, SCAN_DURATION/SCAN_TOTAL at completion, DEVICE_COUNT/PORT_COUNT gauge updates after each scan.
- Added `/metrics` to `_AUTH_EXEMPT_PATHS` in `shared/auth.py`.

#### 6.2 CI/CD Pipeline
- Expanded `.github/workflows/ci.yml` with lint-backend (ruff), test-backend (pytest), test-frontend (vitest), docker-build (on push to main), docker-push (on tags v*).
- Created `backend/pyproject.toml` with ruff config (line-length=120, target-version=py312, select E/W/F/I, ignore E501).

#### 7.1 Credential Fallback Chains
- Created migration `008_credential_fallback.py`: adds `priority` column, drops unique on `ip`, adds composite unique on `(ip, priority)`.
- Updated `Credential` model in `database.py`: added `priority` column, `UniqueConstraint("ip", "priority")`, removed `unique=True` from `ip`.
- Updated `schemas.py`: added `priority` field to `CredentialBase`, `CredentialCreate`, `CredentialUpdate`.
- Updated `routers/credentials.py`: duplicate check now uses `(ip, priority)` instead of just `ip`.
- Updated `scan_engine.py`: credentials loaded ordered by priority, grouped by IP; scan tries primary then fallback credentials in order.
- Updated `CredentialsTab.jsx`: added priority field to form and edit flow.

#### 7.2 Bulk Device Operations
- Added `BulkDeviceMetaUpdate` schema to `schemas.py`.
- Added `PATCH /api/topology/devices/bulk-meta` endpoint to `topology.py`.
- Updated `DevicesTab.jsx`: checkbox per device row, bulk action toolbar (Ignore Selected, Re-enable Selected, Clear), Select All per section.

#### 7.3 Dry-Run Persistence
- Added `DryRunResult` model to `database.py`.
- Created migration `009_dry_run_results.py`.
- Updated `scan_engine.py` dry-run block to persist preview via `_persist_scan_run` + `DryRunResult`.
- Added `GET /api/scan-runs/{run_id}/dry-run-preview` endpoint to `scan_runs.py`.
- Added `DryRunPreviewItem` schema to `schemas.py`.

### Files Created
| File | Description |
|------|-------------|
| backend/shared/metrics.py | Prometheus metric definitions |
| backend/pyproject.toml | Ruff linter configuration |
| backend/alembic/versions/008_credential_fallback.py | Migration for credential priority + fallback |
| backend/alembic/versions/009_dry_run_results.py | Migration for dry-run results table |

### Files Modified
| File | Change |
|------|--------|
| backend/requirements.txt | Added prometheus-client |
| backend/main.py | MetricsMiddleware + /metrics endpoint |
| backend/shared/auth.py | /metrics added to auth-exempt paths |
| backend/shared/metrics.py | NEW: Prometheus metric definitions |
| backend/scan_engine.py | Prometheus instrumentation, credential fallback chains, dry-run persistence |
| backend/database.py | Credential priority + UniqueConstraint, DryRunResult model |
| backend/schemas.py | priority field, BulkDeviceMetaUpdate, DryRunPreviewItem |
| backend/routers/credentials.py | Duplicate check on (ip, priority) |
| backend/routers/topology.py | PATCH /api/topology/devices/bulk-meta |
| backend/routers/scan_runs.py | GET /api/scan-runs/{run_id}/dry-run-preview |
| .github/workflows/ci.yml | Expanded CI/CD pipeline |
| frontend/src/components/settings/CredentialsTab.jsx | Priority field in form |
| frontend/src/components/settings/DevicesTab.jsx | Selection + bulk actions |

---

## v1.6.0 — Phase 1: Foundation (Architecture Improvements)

**Type:** MINOR (new infrastructure + structural improvements)

### Changes

#### 1.1 Structured Error Responses
- Created `backend/shared/errors.py` with `api_error()` helper for consistent error format.
- Added `ErrorDetail`, `APIError` Pydantic schemas to `schemas.py`.
- Added global exception handlers in `main.py` for both `Exception` and `HTTPException`.
- Updated all 11 router files (14 total endpoints) from raw `HTTPException` to structured `api_error()`.
- Updated `shared/auth.py` to return structured error on auth failure.
- Updated `frontend/src/api.js` `_checkOk` to parse `body.error.message`.

#### 1.2 Comprehensive Input Validation
- Added 8 Pydantic models: `ScanSettingsUpdate/Out`, `DnsSettingsUpdate/Out`, `DiscoveryRangesUpdate/Out`, `MapSettingsUpdate/Out`.
- Rewrote `scan_settings.py` to use Pydantic request bodies instead of `request.json()`.
- Updated `map_bg.py` to use `MapSettingsUpdate` body model.

#### 1.3 Consolidate Settings into Database
- Created Alembic migration `005_settings_to_db.py` for new setting keys.
- Rewrote `shared/file_settings.py` from file-based (portalocker) to DB-backed settings via `AppSetting` table.
- Updated `database.py` `_seed_default_settings()` with 7 new setting keys.
- Removed `portalocker` dependency from `requirements.txt`.

#### 1.4 Test Infrastructure Setup
- Created `backend/tests/` package with `conftest.py` (SQLite in-memory, auth fixtures, DB override).
- Created `test_health.py`, `test_credentials.py` (7 CRUD tests), `test_schemas.py` (7 validation tests).
- Added `pytest`, `pytest-asyncio`, `httpx` to `requirements.txt`.
- Added `pytest.ini` for test configuration.
- Made `database.py` engine creation backend-aware (PostgreSQL pool params vs SQLite).

### Files Created
| File | Description |
|------|-------------|
| backend/shared/errors.py | Structured error response helper |
| backend/alembic/versions/005_settings_to_db.py | Migration for DB-backed settings |
| backend/tests/__init__.py | Test package init |
| backend/tests/conftest.py | Shared test fixtures |
| backend/tests/test_health.py | Health endpoint test |
| backend/tests/test_credentials.py | Credential CRUD tests |
| backend/tests/test_schemas.py | Schema validation tests |
| backend/pytest.ini | Pytest configuration |

### Files Modified
| File | Change |
|------|--------|
| backend/schemas.py | Added ErrorDetail, APIError, 8 settings schemas |
| backend/main.py | Structured exception handlers |
| backend/database.py | Conditional engine params, 7 new seed settings |
| backend/shared/auth.py | Structured error format |
| backend/shared/file_settings.py | Complete rewrite to DB-backed |
| backend/requirements.txt | Removed portalocker, added test deps |
| backend/routers/*.py | All 11 router files updated to api_error() |
| frontend/src/api.js | Parse structured error messages |

---

## v1.5.0 — Rack Class Section Reorder

**Type:** MINOR (new feature)

### Changes

#### Rack Detail: Class Section Order Controls
- Added `^` / `v` controls on each class section header in rack detail panel.
- Class section order is now reorderable per rack and persisted in `localStorage`.
- Works for dynamic class sections (`class:<id>`) plus `Other` (unclassified).

### Files Modified
| File | Change |
|------|--------|
| frontend/src/components/map/RackDetail.jsx | Class header reorder controls + local immediate ordering |
| frontend/src/hooks/useRackOrders.js | Persist class-section order per rack (`__class_sections__`) |
| frontend/src/pages/MapPage.jsx | Wire class-section reorder callback into rack detail |

---

## v1.4.0 — Dynamic Rack Class Sections

**Type:** MINOR (new feature)

### Changes

#### Rack Detail: Unlimited Class Groups
- Removed hardcoded rack sections for only Top-of-Rack and Access.
- Rack detail panel now renders a section for every class that is present in the selected rack (`class_id`-based grouping).
- Unclassified devices remain visible in a dedicated `Other` section.
- Reorder persistence now supports dynamic class keys (e.g. `class:<id>`) instead of only `tor/access/other`.

### Files Modified
| File | Change |
|------|--------|
| frontend/src/components/map/RackDetail.jsx | Dynamic per-class sections and render flow |
| frontend/src/hooks/useRackOrders.js | Dynamic class-key reorder support |
| frontend/src/pages/MapPage.jsx | Pass dynamic rack order groups to RackDetail |

---

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
