# P1 Tests Expansion -- Implementation Plan

## Checklist

- [ ] **Phase T1: Scanner Plugin Tests** (`tests/test_scanners.py`) -- 20 tests
  - [ ] T1.1: ArubaCX extract_model (match, no-match, empty)
  - [ ] T1.2: ArubaCX is_virtual_port (virtual, physical)
  - [ ] T1.3: ArubaCX fdb_strategy
  - [ ] T1.4: FS extract_model (match, no-match, empty)
  - [ ] T1.5: FS is_virtual_port (virtual, physical)
  - [ ] T1.6: FS fdb_strategy
  - [ ] T1.7: UniFi extract_model (match, no-match, empty)
  - [ ] T1.8: UniFi is_virtual_port (virtual, physical)
  - [ ] T1.9: UniFi fdb_strategy
  - [ ] T1.10: OPNsense extract_model (match, no-match, empty)
  - [ ] T1.11: OPNsense is_virtual_port (virtual, physical, startswith edge)
  - [ ] T1.12: OPNsense fdb_strategy
  - [ ] T1.13: Generic extract_model (match, no-match, empty)
  - [ ] T1.14: Generic is_virtual_port (virtual, physical)
  - [ ] T1.15: Generic fdb_strategy
  - [ ] T1.16: VendorScanner registry auto-registration
  - [ ] T1.17: extract_model with None input across all scanners
  - [ ] T1.18: extract_model with empty string across all scanners
  - [ ] T1.19: is_virtual_port with empty string across all scanners
  - [ ] T1.20: get_scanner returns cached singleton instances
- [ ] **Phase T2: DB Helpers + CRUD Tests** -- 29 tests
  - [ ] T2.1: `tests/test_db_helpers.py` -- 9 tests for scan_engine/db_helpers.py
  - [ ] T2.2: `tests/test_racks.py` -- 7 tests for routers/racks.py
  - [ ] T2.3: `tests/test_switch_classes.py` -- 6 tests for routers/switch_classes.py
  - [ ] T2.4: `tests/test_switch_models.py` -- 7 tests for routers/switch_models.py
- [ ] **Phase T3: Map Background + Audit + WebSocket** -- 22 tests
  - [ ] T3.1: `tests/test_map_bg.py` -- 8 tests for routers/map_bg.py
  - [ ] T3.2: `tests/test_audit.py` -- 7 tests for routers/audit.py
  - [ ] T3.3: `tests/test_ws.py` -- 7 tests for routers/ws.py
- [ ] **Phase T4: Executor + Scheduler + Jobs** -- 5 tests
  - [ ] T4.1: `tests/test_jobs.py` -- 3 tests for scan_engine/jobs.py
  - [ ] T4.2: `tests/test_scheduler.py` -- 2 tests for scan_engine/scheduler.py
- [ ] **Phase T5: SQLite FK + PG Integration** -- 4 tests
  - [ ] T5.1: Enable PRAGMA foreign_keys in conftest for CASCADE testing
  - [ ] T5.2: `tests/test_cascade.py` -- 4 CASCADE delete tests

**Total new tests: ~80**
**Current tests: 97**
**Projected total: ~177 tests**

---

## Phase T1: Scanner Plugin Tests (20 tests)

### File: `tests/test_scanners.py`

**Dependencies:** None -- pure functions, zero mocking required.

**Setup:** Import scanner classes directly. No conftest fixtures needed.

```python
from scanners.aruba_cx import ArubaCXScanner
from scanners.fs_scanner import FSScanner
from scanners.unifi import UniFiScanner
from scanners.opnsense import OPNsenseScanner
from scanners.generic import GenericScanner
from scanners.base import VendorScanner
```

#### Test Functions

**ArubaCX Scanner (3 tests)**

| # | Function | Input | Expected | Assertion |
|---|----------|-------|----------|-----------|
| 1 | `test_aruba_extract_model_match` | `"ArubaOS-CX, Aruba CX 6300M-48, ..."` | `"Aruba CX 6300M-48"` | `assert result == "Aruba CX 6300M-48"` |
| 2 | `test_aruba_extract_model_no_match` | `"Some other device"` | `""` | `assert result == ""` |
| 3 | `test_aruba_is_virtual_port` | `"loopback0"`, `"vlan100"`, `"1/1/1"` | `True`, `True`, `False` | assert True for virtual, False for physical |

**FS Scanner (3 tests)**

| # | Function | Input | Expected | Assertion |
|---|----------|-------|----------|-----------|
| 4 | `test_fs_extract_model_match` | `"FS S5860-20SQ ..."` | `"FS S5860-20SQ"` | `assert result == "FS S5860-20SQ"` |
| 5 | `test_fs_extract_model_no_match` | `"Unknown device"` | `""` | `assert result == ""` |
| 6 | `test_fs_is_virtual_port` | `"loopback0"`, `"vlan10"`, `"GE0/1"` | `True`, `True`, `False` | assert True/False |

**UniFi Scanner (3 tests)**

| # | Function | Input | Expected | Assertion |
|---|----------|-------|----------|-----------|
| 7 | `test_unifi_extract_model_match` | `"USW-Pro-48-PoE"` | `"USW-Pro-48-PoE"` | `assert result == "USW-Pro-48-PoE"` |
| 8 | `test_unifi_extract_model_no_match` | `"Random AP"` | `""` | `assert result == ""` |
| 9 | `test_unifi_is_virtual_port` | `"bridge0"`, `"cpu"`, `"eth0"` | `True`, `True`, `False` | assert True/False |

**OPNsense Scanner (3 tests)**

| # | Function | Input | Expected | Assertion |
|---|----------|-------|----------|-----------|
| 10 | `test_opnsense_extract_model_match` | `"OPNsense 23.7"` | `"OPNsense 23.7"` | `assert "OPNsense" in result` |
| 11 | `test_opnsense_extract_model_no_match` | `"Linux router"` | `""` | `assert result == ""` |
| 12 | `test_opnsense_is_virtual_port_startswith` | `"loopback0"`, `"vlan100"`, `"em0"`, `"igb0"` | `True`, `True`, `False`, `False` | OPNsense uses `startswith` instead of `in` -- test that `"mlxen0"` does NOT match `"lo"` |

**Generic Scanner (3 tests)**

| # | Function | Input | Expected | Assertion |
|---|----------|-------|----------|-----------|
| 13 | `test_generic_extract_model_match` | `"Cisco WS-C2960X ..."` | `"Cisco WS-C2960X"` | `assert "Cisco" in result` |
| 14 | `test_generic_extract_model_no_match` | `"Telecom device"` | `""` | `assert result == ""` |
| 15 | `test_generic_is_virtual_port` | `"tunnel0"`, `"Gi1/0/1"` | `True`, `False` | assert True/False |

**fdb_strategy (1 parametrized test covering all scanners)**

| # | Function | Scanners | Expected |
|---|----------|----------|----------|
| 16 | `test_fdb_strategy` | Parametrized: `(ArubaCXScanner, "dot1d")`, `(FSScanner, "dot1d")`, `(UniFiScanner, "qbridge")`, `(OPNsenseScanner, "dot1d")`, `(GenericScanner, "dot1d")` | Each returns expected strategy |

**Registry & Edge Cases (4 tests)**

| # | Function | Description | Assertion |
|---|----------|-------------|-----------|
| 17 | `test_vendor_registry_all_registered` | Check `VendorScanner._registry` contains all 5 vendor IDs | `assert set(VendorScanner._registry.keys()) >= {"aruba_cx", "fs", "unifi", "opnsense", "generic"}` |
| 18 | `test_extract_model_none_input` | Parametrized: call `extract_model(None)` on all scanners | `assert result == ""` for each |
| 19 | `test_is_virtual_port_empty_string` | Parametrized: call `is_virtual_port("")` on all scanners | `assert result is False` for each |
| 20 | `test_get_scanner_returns_cached_instance` | Import `get_scanner` from `scanners`; call twice with same vendor | `assert get_scanner("aruba_cx") is get_scanner("aruba_cx")` |

**Mocking strategy:** None -- all tests are pure function calls.

---

## Phase T2: DB Helpers + CRUD Tests (29 tests)

### T2.1: File: `tests/test_db_helpers.py` (9 tests)

**Dependencies:** `db` fixture from conftest for DB-backed tests. Pure function tests need no fixtures.

**Setup:** Import functions directly from `scan_engine.db_helpers`. Since `scan_engine` is mocked in conftest via `sys.modules`, we must import the db_helpers module BEFORE the mock or import it specifically:

```python
# At top of test file, bypass the scan_engine mock for db_helpers specifically
import importlib
import scan_engine.db_helpers as dbh
```

Alternatively, since the mock is a `MagicMock`, attribute access will create sub-mocks. The safest approach: **remove `scan_engine` from the mocked modules list and mock only `scan_engine.executor`** or import `db_helpers` directly by path.

**Recommended approach:** Use `importlib` to load `scan_engine.db_helpers` directly, bypassing the package-level mock.

#### Test Functions

| # | Function | Input | Expected | Fixture |
|---|----------|-------|----------|---------|
| 1 | `test_safe_json_list_valid` | `'["a","b","c"]'` | `["a","b","c"]` | None |
| 2 | `test_safe_json_list_empty` | `""`, `None` | `[]` | None |
| 3 | `test_safe_json_list_invalid` | `"not json"`, `'{"key":"val"}'` | `[]` | None |
| 4 | `test_canonical_link_key_deterministic` | Two calls with same args | Same string | None |
| 5 | `test_canonical_link_key_format` | `("10.0.0.1", "Gi1", "10.0.0.2", "Gi2")` | `"10.0.0.1\|Gi1\|10.0.0.2\|Gi2"` | None |
| 6 | `test_expand_ranges_single_ip` | `["10.0.0.1"]` | `["10.0.0.1"]` | None |
| 7 | `test_expand_ranges_cidr` | `["10.0.0.0/30"]` | `["10.0.0.1", "10.0.0.2"]` | None |
| 8 | `test_expand_ranges_oversized_skipped` | `["10.0.0.0/15"]` | `[]` (>65536 hosts) | None |
| 9 | `test_expand_ranges_invalid_entry` | `["not-an-ip"]` | `[]` | None |

**Mocking strategy:** None for pure functions (tests 1-9). The `_persist_scan_run` and `_read_discovery_ranges` functions require the DB fixture but are lower priority -- skip for now since they are integration-level and the pure functions carry the highest value.

---

### T2.2: File: `tests/test_racks.py` (7 tests)

**Dependencies:** `client`, `jwt_headers`, `viewer_jwt_headers`, `db` fixtures.

**Pattern:** Follows exact same pattern as existing `test_credentials.py`.

#### Test Functions

| # | Function | Method | Path | Headers | Body | Expected Status | Assertion |
|---|----------|--------|------|---------|------|-----------------|-----------|
| 1 | `test_list_racks_empty` | GET | `/api/racks` | None | - | 200 | `r.json() == []` |
| 2 | `test_create_rack` | POST | `/api/racks` | `jwt_headers` | `{"label":"Rack A","room":"RZ-01"}` | 201 | `data["label"] == "Rack A"`, `"id" in data` |
| 3 | `test_list_racks_after_create` | GET | `/api/racks` | None | - | 200 | `len(r.json()) == 1` |
| 4 | `test_update_rack` | PUT | `/api/racks/{id}` | `jwt_headers` | `{"label":"Rack B"}` | 200 | `data["label"] == "Rack B"` |
| 5 | `test_delete_rack` | DELETE | `/api/racks/{id}` | `jwt_headers` | - | 204 | Subsequent GET returns `[]` |
| 6 | `test_update_nonexistent_rack` | PUT | `/api/racks/999` | `jwt_headers` | `{"label":"X"}` | 404 | `data["error"]["code"] == "RACK_NOT_FOUND"` |
| 7 | `test_delete_nonexistent_rack` | DELETE | `/api/racks/999` | `jwt_headers` | - | 404 | `data["error"]["code"] == "RACK_NOT_FOUND"` |

**Mocking strategy:** None needed -- uses existing conftest fixtures. `jwt_headers` provides admin-level auth.

---

### T2.3: File: `tests/test_switch_classes.py` (6 tests)

**Dependencies:** `client`, `jwt_headers`, `db` fixtures.

#### Test Functions

| # | Function | Expected Behavior |
|---|----------|-------------------|
| 1 | `test_list_switch_classes_empty` | GET returns `[]` |
| 2 | `test_create_switch_class` | POST with `{"label":"ToR","color":"#ff0000"}` returns 201 |
| 3 | `test_update_switch_class` | PUT with `{"label":"Aggregation"}` returns 200, label changed |
| 4 | `test_delete_switch_class` | DELETE returns 204, list returns empty |
| 5 | `test_update_nonexistent_switch_class` | PUT `/api/switch-classes/999` returns 404 `SWITCH_CLASS_NOT_FOUND` |
| 6 | `test_deny_outside_rack_false_with_unracked_devices` | Create class with `allow_outside_rack=True`, create a Device with `class_id` set and `rack_id=None`, then PUT `allow_outside_rack=False` returns 409 `OUTSIDE_RACK_IN_USE` |

**Mocking strategy for test 6:** Requires creating a `Device` row in the DB directly via the `db` fixture:

```python
from database import Device
device = Device(ip="10.0.0.1", hostname="sw1", class_id=sc_id, rack_id=None)
db.add(device)
db.commit()
```

---

### T2.4: File: `tests/test_switch_models.py` (7 tests)

**Dependencies:** `client`, `jwt_headers`, `db` fixtures.

#### Test Functions

| # | Function | Expected Behavior |
|---|----------|-------------------|
| 1 | `test_list_switch_models_empty` | GET returns `[]` |
| 2 | `test_create_switch_model` | POST `{"name":"CX 6300","ports_per_row":24}` returns 201 |
| 3 | `test_list_switch_models_after_create` | GET returns 1 item |
| 4 | `test_update_switch_model` | PUT `{"name":"CX 6400"}` returns 200 |
| 5 | `test_delete_switch_model` | DELETE returns 204, list returns empty |
| 6 | `test_update_nonexistent_model` | PUT `/api/switch-models/999` returns 404 `SWITCH_MODEL_NOT_FOUND` |
| 7 | `test_delete_nonexistent_model` | DELETE `/api/switch-models/999` returns 404 `SWITCH_MODEL_NOT_FOUND` |

**Mocking strategy:** None -- same pattern as racks.

---

## Phase T3: Map Background + Audit + WebSocket (22 tests)

### T3.1: File: `tests/test_map_bg.py` (8 tests)

**Dependencies:** `client`, `jwt_headers`, `db` fixtures. Requires mocking filesystem operations.

**Setup:** Patch `MAP_BG_DIR` to a `tmp_path` fixture directory. Patch or disable the `limiter` from `slowapi`.

```python
import pytest
from unittest.mock import patch
from io import BytesIO

@pytest.fixture(autouse=True)
def _patch_map_bg_dir(tmp_path):
    with patch("shared.file_settings.MAP_BG_DIR", str(tmp_path)), \
         patch("routers.map_bg.MAP_BG_DIR", str(tmp_path)):
        yield
```

The `limiter` needs to be handled. The simplest approach: since test requests come quickly, the rate limiter might block. Options:
- Patch the limiter to a no-op, OR
- Set `app.state.limiter` with disabled limits for tests

Recommended: Add a conftest fixture or use SlowAPI's test bypass (set `X-Forwarded-For` headers with unique IPs per test).

#### Test Functions

| # | Function | Description | Mocking | Expected |
|---|----------|-------------|---------|----------|
| 1 | `test_upload_valid_png` | POST multipart with 1x1 PNG bytes | `filetype.guess` returns `type(ext="png")` mock, patched `MAP_BG_DIR` | 200, `{"ok": True}` |
| 2 | `test_upload_unsupported_extension` | POST with `file.exe` | None | 400, `UNSUPPORTED_FILE_TYPE` |
| 3 | `test_upload_oversized_file` | POST with 21MB file | None | 400, `FILE_TOO_LARGE` |
| 4 | `test_upload_invalid_mime_type` | POST `.png` file with wrong magic bytes | `filetype.guess` returns None | 400, `UNSUPPORTED_IMAGE_TYPE` |
| 5 | `test_get_background_none_set` | GET `/api/map-background` with no file | patched `MAP_BG_DIR` (empty dir) | 404, `NO_BACKGROUND_IMAGE` |
| 6 | `test_get_background_after_upload` | Upload then GET | patched `MAP_BG_DIR` | 200, file content |
| 7 | `test_delete_background` | Upload then DELETE then GET | patched `MAP_BG_DIR` | DELETE 200, GET 404 |
| 8 | `test_map_settings_roundtrip` | GET defaults, PUT `{"opacity":0.5,"scale":2.0}`, GET updated | `db` fixture | Values match |

**Key mocking details:**
- `filetype.guess`: For valid PNG test, create real 1x1 PNG bytes (8-byte header: `\x89PNG\r\n\x1a\n` + minimal chunks) so `filetype` can detect it, OR mock `filetype.guess` to return a mock with `.extension = "png"`.
- `MAP_BG_DIR`: Must be patched in BOTH `shared.file_settings` and `routers.map_bg` since `map_bg.py` imports constants directly.
- Rate limiter: Patch `routers.map_bg.limiter` with a mock or use unique IPs.

**Valid 1x1 PNG fixture:**
```python
# Minimal valid PNG (8 bytes header + IHDR + IDAT + IEND)
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n"  # file signature
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05"
    b"\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)
```

---

### T3.2: File: `tests/test_audit.py` (7 tests)

**Dependencies:** `client`, `jwt_headers`, `viewer_jwt_headers`, `db` fixtures.

#### Test Functions

| # | Function | Description | Expected |
|---|----------|-------------|----------|
| 1 | `test_audit_logs_empty` | GET `/api/audit-logs` with admin auth | 200, `[]` |
| 2 | `test_audit_logs_after_crud` | Create a rack (triggers audit), then GET audit logs | List contains entry with `action=="create"`, `resource=="rack"` |
| 3 | `test_audit_log_entry_fields` | After CRUD, check audit log entry fields | Entry has `username`, `action`, `resource`, `resource_id`, `timestamp` |
| 4 | `test_audit_logs_limit_param` | Create 3 racks, GET with `?limit=2` | Returns exactly 2 entries |
| 5 | `test_audit_logs_limit_clamped_to_500` | GET with `?limit=9999` | Query internally clamped to 500 (functional: just check it doesn't error) |
| 6 | `test_audit_logs_viewer_denied` | GET `/api/audit-logs` with `viewer_jwt_headers` | 403 |
| 7 | `test_log_audit_own_session` | Call `log_audit()` with `db=None` (creates own session) | AuditLog row exists in DB |

**Mocking strategy for test 7:**
```python
from unittest.mock import MagicMock
from shared.audit import log_audit

mock_request = MagicMock()
mock_request.state.user = {"id": 1, "username": "testadmin"}
log_audit(mock_request, "test_action", "test_resource", "1", db=None)
# Then query DB to verify row exists
```

**Note:** Since `log_audit` with `db=None` creates its own session via `SessionLocal`, and conftest patches `SessionLocal` to `TestSession`, this will write to the test DB.

---

### T3.3: File: `tests/test_ws.py` (7 tests)

**Dependencies:** `client` fixture, `db` fixture. Requires mocking `config.settings` and `get_redis`.

**Setup:** FastAPI's `TestClient` supports WebSocket testing:
```python
with client.websocket_connect("/ws/scan-progress?token=xxx") as ws:
    ws.send_text("ping")
    data = ws.receive_text()
```

#### Test Functions

| # | Function | Description | Mocking | Expected |
|---|----------|-------------|---------|----------|
| 1 | `test_ws_connect_auth_disabled` | Connect with no token when auth is disabled | Patch `config.settings.jwt_secret=""`, `config.settings.secret_token=""` | Connection accepted |
| 2 | `test_ws_connect_missing_token` | Connect with no token when auth is enabled | Patch `config.settings.jwt_secret="secret"` | WebSocket close code 1008 |
| 3 | `test_ws_connect_legacy_token` | Connect with `token=test-token` | Default `SECRET_TOKEN=test-token` from conftest env | Connection accepted |
| 4 | `test_ws_connect_invalid_token` | Connect with `token=bad` | Default settings from conftest | WebSocket close code 1008 |
| 5 | `test_ws_connect_valid_jwt` | Connect with a valid JWT token | Create user, generate JWT | Connection accepted |
| 6 | `test_ws_connect_ticket_auth` | Connect with a valid Redis ticket | Mock `get_redis` to return mock Redis with `get()` returning truthy, `delete()` | Connection accepted |
| 7 | `test_broadcast_scan_update` | Connect 2 clients, call `broadcast_scan_update`, both receive | `asyncio.run()` or use the async test approach | Both clients receive the message |

**Mocking strategy:**
- `get_redis`: Patch `routers.ws.get_redis` (or `shared.redis_client.get_redis`) to return `None` (no Redis) or a mock Redis object with `get`/`delete` methods.
- `config.settings`: Patch `config.settings.jwt_secret` and `config.settings.secret_token` to control auth behavior.
- For WebSocket exception tests, use `pytest.raises(Exception)` or catch the disconnect.

**WebSocket testing pattern:**
```python
def test_ws_connect_legacy_token(client):
    with client.websocket_connect("/ws/scan-progress?token=test-token") as ws:
        # Connection accepted, send a close
        pass  # Implicit close on context exit
```

For tests expecting rejection, Starlette's TestClient raises an exception on failed WebSocket handshake or returns a close frame:
```python
import pytest
from starlette.websockets import WebSocketDisconnect

def test_ws_connect_invalid_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/scan-progress?token=bad") as ws:
            pass
```

---

## Phase T4: Executor + Scheduler + Jobs (5 tests)

### T4.1: File: `tests/test_jobs.py` (3 tests)

**Dependencies:** `db` fixture. Heavy mocking of `_execute_scan`, `get_redis`, `SessionLocal`, event loop.

**Setup:**
```python
from unittest.mock import patch, MagicMock, AsyncMock
import threading
```

#### Test Functions

| # | Function | Description | Mocking | Expected |
|---|----------|-------------|---------|----------|
| 1 | `test_start_job_thread_fallback` | Call `_start_job()` when Redis unavailable | `get_redis` returns `None`; `_execute_scan` returns a finished `ScanResult`; `_get_bg_loop` returns a real or mock loop | Returns `{"job_id": ..., "status": "running"}` |
| 2 | `test_start_job_celery_dispatch` | Call `_start_job()` when Redis available | `get_redis` returns truthy; `run_scan_task.delay` mocked | Returns `{"job_id": ..., "status": "queued"}` |
| 3 | `test_run_scan_job_exception_sets_failed` | Call `_run_scan_job()` when `_execute_scan` raises | `_execute_scan` raises `RuntimeError`; mock `_get_bg_loop` | Job status updated to `"failed"` |

**Mocking strategy:**
- `_execute_scan`: Patch `scan_engine.jobs._execute_scan` with an `AsyncMock` returning a `ScanResult` or raising.
- `_get_bg_loop`: Patch with a real `asyncio` event loop running in a thread, or mock the `run_coroutine_threadsafe` call.
- `get_redis`: Patch `scan_engine.jobs.get_redis`.
- `SessionLocal`: Already patched in conftest.
- `run_scan_task.delay`: Patch `tasks.run_scan_task.delay`.

**Note:** These tests require careful event loop management. Safest approach: patch `asyncio.run_coroutine_threadsafe` to extract and run the coroutine directly.

---

### T4.2: File: `tests/test_scheduler.py` (2 tests)

**Dependencies:** Heavy mocking of state functions, Redis, Celery, event loop.

#### Test Functions

| # | Function | Description | Mocking | Expected |
|---|----------|-------------|---------|----------|
| 1 | `test_dispatch_skips_when_higher_priority_active` | Call `_dispatch_scheduled_scan("discovery")` when `can_dispatch_scan` returns False | `can_dispatch_scan` returns `False` | Function returns without dispatching (no calls to `run_scan_task.delay`) |
| 2 | `test_dispatch_celery_path` | Call `_dispatch_scheduled_scan("macs")` with Redis available | `can_dispatch_scan` returns `True`; `get_redis` returns truthy; `run_scan_task.delay` mocked | `run_scan_task.delay` called once |

**Mocking strategy:**
- `can_dispatch_scan`: Patch `scan_engine.scheduler.can_dispatch_scan`.
- `get_redis`: Patch `scan_engine.scheduler.get_redis`.
- `run_scan_task.delay`: Patch via `tasks.run_scan_task`.
- `set_scan_job`: Patch `scan_engine.scheduler.set_scan_job`.

---

## Phase T5: SQLite FK + PG Integration (4 tests)

### T5.1: Enable `PRAGMA foreign_keys = ON` in conftest

**Change to `tests/conftest.py`:**

Add an event listener to the engine that enables FK enforcement per connection:

```python
from sqlalchemy import event

@event.listens_for(engine, "connect")
def _enable_fk(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.close()
```

This must be added AFTER the engine creation but BEFORE any DB operations. Place it right after the `engine = create_engine(...)` line.

**Risk:** This may cause existing tests to fail if they rely on FK constraints being disabled (e.g., deleting parents without deleting children). Review existing tests for FK violations before enabling globally. If breakages occur, make the pragma conditional via a fixture rather than global.

**Recommendation:** Start with a dedicated fixture rather than global activation:

```python
@pytest.fixture
def fk_db():
    """DB session with foreign key enforcement enabled."""
    from sqlalchemy import event

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.close()

    session = TestSession()
    try:
        yield session
    finally:
        session.close()
        event.remove(engine, "connect", _enable_fk)
```

### T5.2: File: `tests/test_cascade.py` (4 tests)

**Dependencies:** `fk_db` fixture (with FK enforcement), `client` fixture.

**Setup:** Requires creating parent/child records directly via the DB session.

#### Test Functions

| # | Function | Description | Expected |
|---|----------|-------------|----------|
| 1 | `test_delete_device_cascades_ports` | Create Device + Port; delete Device | Port row also deleted |
| 2 | `test_delete_rack_detaches_devices` | Create Rack + Device(rack_id=rack.id); delete Rack via API | Device still exists but `rack_id=None` (handled by router, not CASCADE) |
| 3 | `test_delete_scan_run_cascades_metrics` | Create ScanRun + ScanRunSwitchMetric; delete ScanRun | Metric row also deleted |
| 4 | `test_delete_snmp_profile_cascades_credentials` | Create SnmpProfile + Credential(profile_id=profile.id); delete SnmpProfile | Credential row also deleted |

**Mocking strategy:** None -- pure DB operations using the `fk_db` fixture.

**Note:** Tests 2 is about the application-level detach logic (not CASCADE) -- the router explicitly sets `rack_id=None` before deleting. We include it to verify the router's detach logic works correctly.

---

## Implementation Order

Execute phases in strict order T1 -> T2 -> T3 -> T4 -> T5. Within each phase, create the test file, implement all tests, run `python -m pytest tests/test_<name>.py -v` to verify, then move to the next file.

### Step-by-step Implementation Instructions

1. **Create `tests/test_scanners.py`** -- Write all 20 scanner tests. Run and verify green.

2. **Create `tests/test_db_helpers.py`** -- Handle the `scan_engine` mock bypass. Write all 9 pure function tests. Run and verify green.

3. **Create `tests/test_racks.py`** -- Write all 7 CRUD tests following the `test_credentials.py` pattern. Run and verify green.

4. **Create `tests/test_switch_classes.py`** -- Write 6 tests including the `allow_outside_rack` conflict test. Run and verify green.

5. **Create `tests/test_switch_models.py`** -- Write all 7 CRUD tests. Run and verify green.

6. **Create `tests/test_map_bg.py`** -- Set up filesystem mocking fixtures. Write all 8 tests. Run and verify green.

7. **Create `tests/test_audit.py`** -- Write all 7 audit tests. Run and verify green.

8. **Create `tests/test_ws.py`** -- Set up WebSocket test helpers. Write all 7 tests. Run and verify green.

9. **Create `tests/test_jobs.py`** -- Set up heavy mocking infrastructure. Write 3 tests. Run and verify green.

10. **Create `tests/test_scheduler.py`** -- Write 2 dispatch tests. Run and verify green.

11. **Update `tests/conftest.py`** -- Add `fk_db` fixture with PRAGMA FK enforcement.

12. **Create `tests/test_cascade.py`** -- Write 4 CASCADE tests using `fk_db` fixture. Run and verify green.

13. **Run full suite:** `python -m pytest tests/ -v` -- All ~177 tests should pass.

---

## Risk Notes

| Risk | Mitigation |
|------|------------|
| `scan_engine` sys.modules mock blocks `db_helpers` import | Import `db_helpers` directly via `importlib.import_module("scan_engine.db_helpers")` or adjust the conftest mock to only mock `scan_engine.executor` |
| Rate limiter blocks rapid map_bg test uploads | Patch `routers.map_bg.limiter` fixture or use unique client IPs |
| WebSocket tests may be flaky with async timing | Use `TestClient` synchronous WebSocket API; avoid spinning up real async loops |
| FK PRAGMA may break existing tests | Use dedicated `fk_db` fixture instead of global pragma |
| `jobs.py` tests require event loop coordination | Patch `asyncio.run_coroutine_threadsafe` to run coroutines synchronously |
