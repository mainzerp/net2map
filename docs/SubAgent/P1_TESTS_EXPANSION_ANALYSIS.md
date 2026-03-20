# P1 Tests Expansion -- Research & Analysis

## Current State

- **97 tests** across 13 test files (29.4% coverage)
- Test infrastructure: SQLite in-memory with JSONB-to-JSON patching, `conftest.py` with `client`, `db`, `auth_headers`, `jwt_headers`, `viewer_jwt_headers` fixtures
- Heavy modules (`pysnmp`, `snmp_scanner`, `scan_engine`) are mocked at import level via `sys.modules`

---

## Part 1: Further Backend Test Expansion

### 1. Scanner Plugins (aruba_cx, fs_scanner, unifi, opnsense, generic)

**Files:** `scanners/aruba_cx.py`, `scanners/fs_scanner.py`, `scanners/unifi.py`, `scanners/opnsense.py`, `scanners/generic.py`, `scanners/base.py`

**Analysis:** Each scanner is a pure-logic class (20--35 lines) implementing three methods:
- `extract_model(sys_descr) -> str` -- regex extraction, pure function
- `is_virtual_port(if_descr) -> bool` -- string matching, pure function
- `fdb_strategy() -> str` -- returns constant

**Testable units:**
- `extract_model()` with matching sysDescr strings, non-matching strings, empty/None input (3 cases per scanner x 5 scanners = 15)
- `is_virtual_port()` with virtual port names, physical port names (2 cases per scanner x 5 = 10)
- `fdb_strategy()` returns expected value (1 per scanner = 5)
- `VendorScanner._registry` auto-registration (1 test)
- Edge cases: empty string, None (shared across scanners)

**Mocking:** None needed -- these are pure functions with zero dependencies.

**Complexity:** Low
**Estimated tests:** ~20
**Priority:** 1 (highest value/effort ratio -- zero mocking, pure logic, fast to write)

---

### 2. Rack/Class/Model CRUD (routers/racks.py, switch_classes.py, switch_models.py)

**Files:** `routers/racks.py` (~55 lines), `routers/switch_classes.py` (~70 lines), `routers/switch_models.py` (~60 lines)

**Analysis:** Standard CRUD routers following identical patterns. Each has:
- `GET /api/{resource}` -- list all (no auth)
- `POST /api/{resource}` -- create (admin/operator)
- `PUT /api/{resource}/{id}` -- update (admin/operator)
- `DELETE /api/{resource}/{id}` -- delete (admin only)

Special behaviors:
- **Racks:** delete detaches devices (`rack_id = None`)
- **Switch Classes:** update with `allow_outside_rack=False` checks for unracked devices (409 conflict), delete detaches devices
- **Switch Models:** delete detaches devices (`model_id = None`)
- All endpoints create audit log entries

**Testable units per router (6 each, 18 total):**
1. List empty returns `[]`
2. Create returns 201 with data
3. Get after create returns item
4. Update returns modified data
5. Delete returns 204, item removed
6. Update/delete nonexistent returns 404

**Additional for switch_classes (2 extra):**
7. `allow_outside_rack=False` with unracked devices returns 409
8. `allow_outside_rack=False` with all racked devices succeeds

**Mocking:** None beyond existing `conftest.py` fixtures. Uses `jwt_headers` for auth.

**Complexity:** Low -- follows exact same pattern as existing `test_credentials.py`
**Estimated tests:** ~20
**Priority:** 2 (straightforward CRUD, high coverage gain, exact pattern already exists)

---

### 3. Audit Logging (routers/audit.py, shared/audit.py)

**Files:** `routers/audit.py` (~20 lines), `shared/audit.py` (~35 lines)

**Analysis:**
- `GET /api/audit-logs` -- admin-only endpoint returning recent audit entries (limit clamped to 500)
- `log_audit()` -- helper that writes `AuditLog` rows; can use provided or own session

**Testable units:**
1. `GET /api/audit-logs` returns empty list initially
2. After a CRUD operation (e.g., create rack), audit log entry appears
3. Audit entry contains correct action, resource, username
4. `limit` parameter works (default 100, max 500)
5. Non-admin access denied (viewer role)
6. `log_audit()` with explicit db session writes entry
7. `log_audit()` fallback to own session (test with `db=None`)

**Mocking:** Minimal -- need `jwt_headers` for auth. `log_audit` is called implicitly by CRUD routers.

**Complexity:** Low
**Estimated tests:** ~7
**Priority:** 3 (tests audit system end-to-end via existing CRUD endpoints)

---

### 4. Map Background Upload (routers/map_bg.py)

**Files:** `routers/map_bg.py` (~100 lines), `shared/file_settings.py` (file I/O helpers)

**Analysis:**
- `POST /api/map-background` -- file upload with validation (ext, size, MIME type, SVG sanitization)
- `GET /api/map-background` -- return stored file (404 if none)
- `DELETE /api/map-background` -- remove stored file
- `GET /api/map-settings` -- return opacity/scale settings
- `PUT /api/map-settings` -- update settings

Key validation:
- Unsupported file extension -> 400
- File too large (>20MB) -> 400
- Invalid MIME type -> 400
- SVG sanitization strips script tags and event handlers

**Testable units:**
1. Upload valid PNG file returns 200
2. Upload unsupported extension returns 400
3. Upload oversized file returns 400
4. Get background when none set returns 404
5. Delete background returns 200
6. Get/update map settings

**Mocking required:**
- `_find_bg_file`, `_clear_bg_files` -- file system operations (mock or use tmp directory)
- `MAP_BG_DIR` -- needs to be patched to a temp directory
- Rate limiter may need to be disabled/mocked for tests
- `filetype.guess` for MIME validation

**Complexity:** Medium (file I/O mocking, multipart upload via TestClient)
**Estimated tests:** ~8
**Priority:** 4 (medium effort due to file I/O mocking)

---

### 5. WebSocket (routers/ws.py)

**Files:** `routers/ws.py` (~110 lines)

**Analysis:**
- Single WebSocket endpoint `/ws/scan-progress`
- Authentication: ticket-based (Redis lookup) or JWT fallback or legacy token
- Broadcast functions: `broadcast_scan_update()`, `broadcast_scan_update_sync()`
- Client management: `_clients` set with asyncio lock

**Testable units:**
1. Connect with valid token succeeds (accepted)
2. Connect without token when auth enabled raises 1008
3. Connect with invalid token raises 1008
4. Connect with legacy `SECRET_TOKEN` value succeeds
5. `_authenticate_ws()` with auth disabled (no jwt_secret/legacy_token) passes
6. `broadcast_scan_update()` sends to connected clients
7. `broadcast_scan_update_sync()` fire-and-forget wrapper

**Mocking required:**
- Redis for ticket-based auth (`get_redis` mock)
- `config.settings` for auth configuration
- FastAPI `TestClient` supports WebSocket testing via `with client.websocket_connect()`

**Complexity:** Medium (WebSocket test patterns with TestClient, async client management)
**Estimated tests:** ~7
**Priority:** 5 (WebSocket testing is well-supported by FastAPI/Starlette TestClient)

---

### 6. scan_engine/db_helpers.py

**Files:** `scan_engine/db_helpers.py` (~100 lines)

**Analysis:** Pure utility functions:
- `_safe_json_list(raw)` -- parse JSON string to list, fallback to empty
- `_canonical_link_key(...)` -- deterministic string key for topology links
- `_persist_scan_run(db, result, ...)` -- write ScanRun + ScanRunSwitchMetric to DB
- `_read_discovery_ranges(db)` -- read AppSetting JSON value
- `_expand_ranges_to_ips(ranges)` -- CIDR expansion with safety limits

**Testable units:**
1. `_safe_json_list` with valid JSON list
2. `_safe_json_list` with invalid/empty input
3. `_canonical_link_key` produces deterministic key
4. `_expand_ranges_to_ips` with single IP
5. `_expand_ranges_to_ips` with /24 CIDR
6. `_expand_ranges_to_ips` with oversized range (>65536) skipped
7. `_expand_ranges_to_ips` with invalid input
8. `_read_discovery_ranges` reads AppSetting
9. `_persist_scan_run` creates ScanRun record

**Mocking:** Minimal for pure functions; DB fixture for `_persist_scan_run` and `_read_discovery_ranges`.

**Complexity:** Low (mostly pure functions)
**Estimated tests:** ~9
**Priority:** 2 (same priority as CRUD -- high value, pure logic)

---

### 7. scan_engine/jobs.py

**Files:** `scan_engine/jobs.py` (~90 lines)

**Analysis:**
- `_run_scan_job(job_id, cancel_event, ...)` -- runs `_execute_scan` in background loop, updates job state
- `_start_job(...)` -- creates job, dispatches via Celery or thread fallback

**Testable units:**
1. `_start_job()` with Redis unavailable -> thread fallback, returns `{job_id, status: "running"}`
2. `_start_job()` with Redis available -> Celery dispatch, returns `{job_id, status: "queued"}`
3. `_run_scan_job()` with mocked `_execute_scan` success -> updates job status to "finished"
4. `_run_scan_job()` with `_execute_scan` raising exception -> updates job status to "failed"

**Mocking required:**
- `_execute_scan` -- must be mocked (depends on SNMP scanner)
- `get_redis` -- mock for Celery vs thread path selection
- `run_scan_task.delay` -- mock Celery task
- `_get_bg_loop` -- mock event loop
- `SessionLocal` -- use test DB session

**Complexity:** Medium-High (async event loop mocking, threading coordination)
**Estimated tests:** ~5
**Priority:** 6 (significant mocking overhead)

---

### 8. scan_engine/scheduler.py

**Files:** `scan_engine/scheduler.py` (~120 lines)

**Analysis:**
- `_dispatch_scheduled_scan(scan_type)` -- checks lock, dispatches via Celery or direct execution
- `_background_scheduler()` -- infinite loop polling AppSetting intervals, dispatches scans

**Testable units:**
1. `_dispatch_scheduled_scan()` skips when higher-priority scan active
2. `_dispatch_scheduled_scan()` dispatches via Celery when Redis available
3. `_dispatch_scheduled_scan()` falls back to direct execution
4. `_dispatch_scheduled_scan()` handles lock timeout

**Mocking required:**
- `can_dispatch_scan` -- state check
- `get_redis` -- Celery path
- `run_scan_task.delay` -- Celery dispatch
- `acquire_scan_lock` / `release_scan_lock` -- locking
- `_execute_scan` -- actual scan
- `_get_bg_loop` -- event loop

**Note:** `_background_scheduler()` is an infinite loop -- not directly testable without refactoring. Only `_dispatch_scheduled_scan()` is unit-testable.

**Complexity:** Medium-High
**Estimated tests:** ~4
**Priority:** 7 (high mocking cost, scheduler loop not directly testable)

---

### 9. scan_engine/executor.py

**Files:** `scan_engine/executor.py` (~830 lines)

**Analysis:** The monolithic `_execute_scan()` function is extremely tightly coupled:
- 830 lines in a single async function with nested async closures
- Depends on: DB sessions, SNMP scanner, ping subprocess, DNS resolution, broadcast, metrics, file settings
- Contains nested functions: `_cred_to_snmp_dict`, `_ping_host_async`, `_scan_target_async`

**Extractable/testable pieces (without refactoring executor itself):**
- `_cred_to_snmp_dict(cred)` -- but it's a closure, not extractable without refactor
- Port update logic, link resolution logic -- deeply embedded in the function

**What CAN be tested via integration (with heavy mocking):**
1. `_execute_scan()` with no credentials and no ranges -> returns `ScanResult(scanned=0, errors=[...])`
2. `_execute_scan()` with cancel_event set -> returns status "cancelled"

**Mocking required for any executor test:**
- `scan_switch` (SNMP scanner)
- `_build_ping_cmd` / subprocess
- DNS resolution
- All broadcast functions
- Prometheus metrics
- `_read_scan_settings`, `_read_dns_settings`

**Complexity:** Very High
**Estimated tests:** ~2 (only the trivial paths)
**Priority:** 8 (lowest -- massive mocking, minimal value without refactoring internal functions out)

---

## Part 2: PostgreSQL Integration Tests

### Current SQLite Limitations

The test suite patches `JSONB -> JSON` at import time:
```python
import sqlalchemy.dialects.postgresql as _pg
from sqlalchemy import JSON as _JSON
_pg.JSONB = _JSON
```

This means tests never exercise:
1. JSONB-specific operators (`@>`, `?`, `->`, `->>`)
2. JSONB indexing (GIN indexes)
3. PostgreSQL CASCADE behavior (SQLite FK enforcement is off by default)
4. Connection pooling (`pool_size=10, max_overflow=20, pool_pre_ping=True`)
5. Transaction isolation levels
6. `server_default=func.now()` PostgreSQL behavior

### JSONB Usage in Codebase

7 JSONB columns across 4 tables:
| Table | Column | Default |
|-------|--------|---------|
| `ports` | `endpoint_details_json` | `[]` |
| `ports` | `tagged_vlans` | `[]` |
| `audit_logs` | `details` | `{}` |
| `scan_runs` | `devices_snapshot_json` | `[]` |
| `scan_runs` | `links_snapshot_json` | `[]` |
| `dry_run_results` | `preview_json` | `[]` |

**Current JSONB operations:** None of the application code uses PostgreSQL-specific JSONB operators (`@>`, `?`, `->>`). All JSONB columns are read/written as whole values (Python dicts/lists). This means SQLite JSON compatibility is actually sufficient for current functionality.

### CASCADE Behavior

Alembic migrations define `ON DELETE CASCADE` for:
- `ports.device_id -> devices.id`
- `devices.rack_id -> racks.id`
- `devices.class_id -> switch_classes.id`
- `devices.model_id -> switch_models.id`
- `credentials.profile_id -> snmp_profiles.id`
- `credentials.rack_id -> racks.id`
- `credentials.class_id -> switch_classes.id`
- `scan_run_switch_metrics.scan_run_id -> scan_runs.id`
- `dry_run_results.scan_run_id -> scan_runs.id` (migration 010)

SQLite does NOT enforce foreign keys by default (`PRAGMA foreign_keys = OFF`). The conftest does not enable them. This means CASCADE delete behavior is **completely untested**.

### testcontainers Availability

- **Not in requirements.txt** -- would need to be added as a test dependency
- Python package: `testcontainers[postgres]` provides `PostgresContainer`
- Requires Docker to be available on the test host

### Feasibility Assessment

**Option A: testcontainers (recommended)**
- Pros: Real PostgreSQL instance, tests all PG-specific behavior, no Docker-in-Docker needed (runs locally with Docker Desktop)
- Cons: Slower test startup (~2-5s container spin-up), requires Docker, adds dependency
- Implementation: Create a `pg_engine` fixture that starts `PostgresContainer`, runs `Base.metadata.create_all()`, yields session, stops container
- Mark PG tests with `@pytest.mark.requires_postgres` (marker already defined in conftest)

**Option B: SQLite with FK enforcement**
- Add `PRAGMA foreign_keys = ON` to SQLite test engine
- Tests CASCADE behavior without PG
- Does NOT test JSONB, pooling, or transaction isolation
- Zero new dependencies

**Option C: Skip PG tests unless `DATABASE_URL` is set**
- No testcontainers dependency
- Requires manual PG setup or CI with PG service
- `@pytest.mark.skipif(not os.getenv("TEST_PG_URL"), ...)`

**Recommendation:** Start with **Option B** (SQLite FK enforcement) for immediate CASCADE test coverage, then add **Option A** (testcontainers) for comprehensive PG testing. This gives incremental value.

### Recommended PG-Specific Tests

1. CASCADE delete: delete device -> ports deleted
2. CASCADE delete: delete scan_run -> switch_metrics deleted
3. CASCADE delete: delete scan_run -> dry_run_results deleted
4. JSONB column read/write roundtrip (list, dict)
5. JSONB default values applied correctly
6. Connection pool behavior under concurrent access
7. Transaction rollback isolation

**Estimated tests:** ~7

---

## Summary & Priority Order

| Priority | Area | Estimated Tests | Complexity | Mocking |
|----------|------|-----------------|------------|---------|
| 1 | Scanner plugins | ~20 | Low | None |
| 2 | db_helpers.py | ~9 | Low | Minimal |
| 3 | Rack/Class/Model CRUD | ~20 | Low | Existing fixtures |
| 4 | Audit logging | ~7 | Low | Existing fixtures |
| 5 | Map background upload | ~8 | Medium | File I/O, rate limiter |
| 6 | WebSocket | ~7 | Medium | Redis, config |
| 7 | scan_engine/jobs.py | ~5 | Medium-High | Event loop, Celery |
| 8 | scan_engine/scheduler.py | ~4 | Medium-High | State, locks, Celery |
| 9 | scan_engine/executor.py | ~2 | Very High | Everything |
| 10 | PostgreSQL integration | ~7 | Medium | testcontainers or FK pragma |

**Total estimated new tests: ~89**
**Current tests: 97**
**Projected total: ~186 tests**

### Recommended Implementation Order

1. **Scanner plugins** (20 tests) -- pure logic, zero dependencies, maximum value/effort
2. **db_helpers** (9 tests) -- pure utility functions, easy to test
3. **Rack/Class/Model CRUD** (20 tests) -- follows existing credential test pattern exactly
4. **Audit logging** (7 tests) -- tests audit system end-to-end, leverages CRUD tests
5. **Map background** (8 tests) -- file upload testing with mocked filesystem
6. **WebSocket** (7 tests) -- FastAPI TestClient WebSocket support
7. **PG integration** (7 tests) -- start with SQLite FK pragma, add testcontainers later
8. **jobs.py** (5 tests) -- significant mocking but manageable
9. **scheduler.py** (4 tests) -- only `_dispatch_scheduled_scan` is testable
10. **executor.py** (2 tests) -- only trivial empty/cancelled paths worth testing without refactor

### Key Decisions Needed

1. Should `testcontainers[postgres]` be added to requirements.txt? (adds ~2-5s test startup per PG test)
2. Should executor.py internal functions be refactored to be testable? (would unlock ~10 more tests but changes production code)
3. Should SQLite FK enforcement be enabled globally or only for CASCADE-specific tests?
