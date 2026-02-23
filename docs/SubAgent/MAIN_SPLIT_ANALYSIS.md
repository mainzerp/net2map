# main.py Split Analysis

**File:** `backend/main.py` — 2123 lines  
**Goal:** Identify a clean router-based split with no circular dependencies.

---

## 1. All Imports at the Top of `main.py`

### Standard Library
```
asyncio, json, csv, hashlib, imghdr, io, logging, os, platform,
re, socket, shutil, ipaddress, time, threading, uuid, subprocess
collections.deque
concurrent.futures.ThreadPoolExecutor, as_completed
datetime.datetime
typing.Dict, List, Optional
```

### Third-Party / FastAPI
```
fastapi: Depends, FastAPI, HTTPException, Request, UploadFile, File
fastapi.middleware.cors: CORSMiddleware
fastapi.responses: FileResponse, Response
fastapi.security: HTTPBearer, HTTPAuthorizationCredentials
fastapi: Security, status
sqlalchemy.orm: Session
```

### Local Modules
```
database:
  Credential, Device, Port, TopologyLink, SnmpProfile,
  ScanRun, ScanRunSwitchMetric, SessionLocal,
  Rack as RackModel, SwitchClass as SwitchClassModel,
  SwitchModel as SwitchModelModel, AppSetting,
  create_tables, get_db

schemas:
  CredentialCreate, CredentialOut, CredentialUpdate,
  DeviceOut, DevicePositionUpdate, DeviceMetaUpdate, RackPositionUpdate,
  ScanResult, ScanRunOut, ScanSwitchMetric, TopologyOut, TopologyLinkOut,
  SnmpProfileCreate, SnmpProfileUpdate, SnmpProfileOut,
  RackCreate, RackUpdate, RackOut,
  SwitchClassCreate, SwitchClassUpdate, SwitchClassOut,
  SwitchModelCreate, SwitchModelUpdate, SwitchModelOut,
  AppSettingOut, AppSettingUpdate,
  BulkImportRequest, BulkImportResult, BulkImportError, BulkExportOut,
  GlobalConfigExportOut, GlobalConfigImportRequest

snmp_scanner:
  LldpNeighbor, SwitchData, auto_layout, scan_switch,
  extract_model, is_virtual, speed_label
```

---

## 2. All Shared Globals / State

| Name | Type | Description |
|------|------|-------------|
| `SECRET_TOKEN` | `str` (env) | Auth token from `SECRET_TOKEN` env var |
| `CORS_ORIGIN` | `str` (env) | Allowed CORS origin from `CORS_ORIGIN` env var |
| `_bearer` | `HTTPBearer` | FastAPI security scheme instance |
| `app` | `FastAPI` | The application instance |
| `SCAN_JOBS` | `Dict[str, dict]` | In-memory map of job_id → job state dict |
| `SCAN_JOBS_LOCK` | `threading.Lock` | Guards all reads/writes of `SCAN_JOBS` |
| `LOG_BUFFER` | `deque(maxlen=5000)` | In-process structured log buffer |
| `LOG_BUFFER_LOCK` | `threading.Lock` | Guards all reads/writes of `LOG_BUFFER` |
| `PROFILE_BULK_FIELDS` | `List[str]` | CSV column order for SNMP profile export |
| `CREDENTIAL_BULK_FIELDS` | `List[str]` | CSV column order for credential export |
| `MAP_BG_DIR` | `str` | Data directory path (`/data`) |
| `MAP_BG_FILENAME` | `str` | Background image base filename |
| `ALLOWED_EXTENSIONS` | `set` | Permitted image extensions |
| `ALLOWED_IMAGE_TYPES` | `set` | Permitted imghdr-detected types |
| `MAX_FILE_SIZE` | `int` | 20 MB hard limit |
| `MAP_SETTINGS_PATH` | `str` | Path to `map-settings.json` |
| `DEFAULT_MAP_SETTINGS` | `dict` | Fallback values for map settings |
| `SCAN_SETTINGS_PATH` | `str` | Path to `scan-settings.json` |
| `DEFAULT_SCAN_SETTINGS` | `dict` | Fallback values for scan settings |
| `DNS_SETTINGS_PATH` | `str` | Path to `dns-settings.json` |
| `DEFAULT_DNS_SETTINGS` | `dict` | Fallback values for DNS settings |

---

## 3. All Routes / Endpoints Grouped by Resource

### Health (line 176)
| Method | Path | Function |
|--------|------|----------|
| GET | `/health` | `health()` |

---

### Settings (lines 179–184)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/settings` | `list_settings()` |
| PUT | `/api/settings/{key}` | `update_setting()` |

**Uses:** `AppSetting`, `AppSettingOut`, `AppSettingUpdate`

---

### Stats (lines 185–199)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/stats` | `get_stats()` |

**Uses:** `Device`, `Port`, `RackModel`, `ScanRun`; imports `sqlalchemy.func` inline.

---

### BulkImport / BulkExport (lines 290–407)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/bulk-export/{kind}` | `bulk_export()` |
| POST | `/api/bulk-import/{kind}` | `bulk_import()` |

**Uses:** `Credential`, `SnmpProfile`, bulk helper functions, `PROFILE_BULK_FIELDS`, `CREDENTIAL_BULK_FIELDS`

---

### Config (lines 414–540)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/config/export` | `export_global_config()` |
| POST | `/api/config/import` | `import_global_config()` |

**Uses:** `AppSetting`, `SnmpProfile`, `Credential`; normalizer helpers; `SnmpProfileCreate`, `CredentialCreate`

---

### SNMP Profiles (lines 545–583)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/snmp-profiles` | `list_snmp_profiles()` |
| POST | `/api/snmp-profiles` | `create_snmp_profile()` |
| PUT | `/api/snmp-profiles/{profile_id}` | `update_snmp_profile()` |
| DELETE | `/api/snmp-profiles/{profile_id}` | `delete_snmp_profile()` |

**Uses:** `SnmpProfile`, `Credential`, `SnmpProfileCreate`, `SnmpProfileUpdate`, `SnmpProfileOut`

---

### Racks (lines 587–620)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/racks` | `list_racks()` |
| POST | `/api/racks` | `create_rack()` |
| PUT | `/api/racks/{rack_id}` | `update_rack()` |
| DELETE | `/api/racks/{rack_id}` | `delete_rack()` |

**Uses:** `RackModel`, `Device`, `RackCreate`, `RackUpdate`, `RackOut`

---

### SwitchClasses (lines 621–660)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/switch-classes` | `list_switch_classes()` |
| POST | `/api/switch-classes` | `create_switch_class()` |
| PUT | `/api/switch-classes/{class_id}` | `update_switch_class()` |
| DELETE | `/api/switch-classes/{class_id}` | `delete_switch_class()` |

**Uses:** `SwitchClassModel`, `Device`, `SwitchClassCreate`, `SwitchClassUpdate`, `SwitchClassOut`

---

### SwitchModels (lines 661–700)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/switch-models` | `list_switch_models()` |
| POST | `/api/switch-models` | `create_switch_model()` |
| PUT | `/api/switch-models/{model_id}` | `update_switch_model()` |
| DELETE | `/api/switch-models/{model_id}` | `delete_switch_model()` |

**Uses:** `SwitchModelModel`, `Device`, `SwitchModelCreate`, `SwitchModelUpdate`, `SwitchModelOut`

---

### Credentials (lines 701–760)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/credentials` | `list_credentials()` |
| POST | `/api/credentials` | `create_credential()` |
| PUT | `/api/credentials/{cred_id}` | `update_credential()` |
| DELETE | `/api/credentials/{cred_id}` | `delete_credential()` |

**Uses:** `Credential`, `Device`, `CredentialCreate`, `CredentialUpdate`, `CredentialOut`

---

### Scan (lines 1390–1500)
| Method | Path | Function |
|--------|------|----------|
| POST | `/api/scan` | `run_scan()` — sync compat wrapper |
| POST | `/api/scan/jobs` | `start_scan_job()` — background job |
| POST | `/api/scan/dry-run/jobs` | `start_dry_run_job()` — dry-run job |
| GET | `/api/scan/jobs/{job_id}` | `get_scan_job()` |
| POST | `/api/scan/jobs/{job_id}/cancel` | `cancel_scan_job()` |

**Uses:** `SCAN_JOBS`, `SCAN_JOBS_LOCK`, `_execute_scan`, `_start_job`, `_run_scan_job`, `_log_event`, `ScanResult`

---

### ScanRuns (lines 1501–1610)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/scan-runs` | `list_scan_runs()` |

**Uses:** `ScanRun`, `ScanRunOut`, `ScanSwitchMetric`, `_safe_json_list`

---

### Topology (lines 1612–1682)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/topology` | `get_topology()` |
| PATCH | `/api/topology/devices/{device_id}/position` | `update_device_position()` |
| PATCH | `/api/topology/racks/{rack_id}/position` | `update_rack_position()` |
| PATCH | `/api/topology/devices/{device_id}/meta` | `update_device_meta()` |

**Uses:** `Device`, `TopologyLink`, `RackModel`, `SwitchClassModel`, `SwitchModelModel`, `DeviceOut`, `TopologyOut`, `DevicePositionUpdate`, `DeviceMetaUpdate`, `RackPositionUpdate`, `RackOut`; also `hashlib.md5` for ETag

---

### MapBackground / MapBg (lines 1726–1748)
| Method | Path | Function |
|--------|------|----------|
| POST | `/api/map-background` | `upload_map_background()` |
| GET | `/api/map-background` | `get_map_background()` |
| DELETE | `/api/map-background` | `delete_map_background()` |

**Uses:** `MAP_BG_DIR`, `MAP_BG_FILENAME`, `ALLOWED_EXTENSIONS`, `ALLOWED_IMAGE_TYPES`, `MAX_FILE_SIZE`, `_find_bg_file`, `_clear_bg_files`

---

### MapSettings (lines 1750–1770)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/map-settings` | `get_map_settings()` |
| PUT | `/api/map-settings` | `update_map_settings()` |

**Uses:** `_read_map_settings`, `_write_map_settings`, `MAP_SETTINGS_PATH`, `DEFAULT_MAP_SETTINGS`

---

### ScanSettings (lines 1788–1827)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/scan-settings` | `get_scan_settings()` |
| PUT | `/api/scan-settings` | `update_scan_settings()` |

**Uses:** `_read_scan_settings`, `_write_scan_settings`, `_normalize_scan_settings`, `SCAN_SETTINGS_PATH`, `DEFAULT_SCAN_SETTINGS`

---

### DiscoveryRanges (lines 1828–1870)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/discovery-ranges` | `get_discovery_ranges()` |
| PUT | `/api/discovery-ranges` | `update_discovery_ranges()` |

**Uses:** `_read_discovery_ranges`, `AppSetting`

---

### DnsSettings (lines 1870–1920)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/dns-settings` | `get_dns_settings()` |
| PUT | `/api/dns-settings` | `update_dns_settings()` |

**Uses:** `_normalize_dns_servers`, `_read_dns_settings`, `_write_dns_settings`, `DNS_SETTINGS_PATH`, `DEFAULT_DNS_SETTINGS`

---

### Logs (lines 1918–1940)
| Method | Path | Function |
|--------|------|----------|
| GET | `/api/logs` | `get_logs()` |

**Uses:** `LOG_BUFFER`, `LOG_BUFFER_LOCK`

---

## 4. Helper Functions (Non-Route)

| Function | Purpose |
|----------|---------|
| `_require_auth(credentials)` | FastAPI `Security` dependency; enforces `SECRET_TOKEN` if configured |
| `_log_event(level, event, **fields)` | Appends structured JSON entry to `LOG_BUFFER` and emits to Python logger |
| `_background_scheduler()` | Daemon thread; polls AppSettings for discovery/link/MAC intervals and calls `_execute_scan` |
| `_normalize_bool(value)` | `"true"/"1"/"yes"` → `True`, otherwise `False`; used in bulk CSV parsing |
| `_normalize_optional_int(value)` | `""` / `None` → `None`, otherwise `int(value)` |
| `_parse_bulk_rows(kind, body)` | Deserializes JSON or CSV body into list of dicts; normalises int/bool fields |
| `_validate_bulk_rows(kind, rows)` | Runs each row through Pydantic schema; returns `(valid_rows, errors)` |
| `_serialize_bulk_rows(kind, rows, fmt)` | Serializes list of dicts back to JSON or CSV string |
| `_safe_json_list(raw)` | Safely decodes a JSON string to `List[str]`; returns `[]` on failure |
| `_canonical_link_key(local_ip, local_port, remote_ip, remote_port)` | Produces `"ip|port|ip|port"` for snapshot diffing in `_persist_scan_run` |
| `_persist_scan_run(db, result, devices_snapshot, links_snapshot)` | Writes `ScanRun` + `ScanRunSwitchMetric` rows to DB; returns `run.id` |
| `_read_discovery_ranges(db)` | Reads `discovery_scan_ranges` from `AppSetting`; returns `List[str]` |
| `_expand_ranges_to_ips(ranges)` | Expands CIDR/IP strings to individual IP strings; skips ranges with >65536 hosts |
| `_execute_scan(db, cancel_event, correlation_id, scan_type, dry_run)` | Core async scan engine: builds scan targets, runs concurrent async ping+SNMP, writes Device/Port/TopologyLink/Credential rows |
| `_run_scan_job(job_id, cancel_event, dry_run)` | Sync thread-target wrapper for `_execute_scan`; updates `SCAN_JOBS[job_id]` |
| `_start_job(dry_run)` | Creates `SCAN_JOBS` entry, spawns `_run_scan_job` thread, returns `{job_id, status}` |
| `_find_bg_file()` | Searches `MAP_BG_DIR` for any current background image file |
| `_clear_bg_files()` | Deletes all background image variants from `MAP_BG_DIR` |
| `_read_map_settings()` | Reads `map-settings.json`; merges with defaults |
| `_write_map_settings(data)` | Merges and writes `map-settings.json` |
| `_normalize_scan_settings(value)` | Validates and clamps `max_workers`, `snmp_timeout`, `snmp_retries` |
| `_read_scan_settings()` | Reads `scan-settings.json`; returns defaults on failure |
| `_write_scan_settings(value)` | Validates and writes `scan-settings.json` |
| `_normalize_dns_servers(value)` | Validates list of IP strings; deduplicates, preserves order |
| `_read_dns_settings()` | Reads `dns-settings.json`; returns defaults on failure |
| `_write_dns_settings(servers)` | Validates and writes `dns-settings.json` |
| `_build_ping_cmd(ip, timeout_sec)` | Returns OS-specific `ping` subprocess args (Windows vs POSIX) |
| `_ping_host(ip, timeout_sec)` | Subprocess ping (sync); parses RTT from stdout; returns `(reachable, rtt_ms)` |
| `_resolve_ip(sys_name, switch_data)` | Looks up management IP by sysName in scan batch; falls back to `socket.gethostbyname` |
| `_resolve_host(ip, cache, dns_servers, correlation_id)` | Reverse DNS lookup; tries custom resolver first, then system; caches results |

**Inner async functions defined inside `_execute_scan`:**
- `_ping_host_async(ip, timeout_sec)` — asyncio subprocess ping variant
- `_scan_target_async(target, sem)` — acquires semaphore, pings, runs `scan_switch()`; handles range-probe multi-profile retry

---

## 5. `_execute_scan` — What It Imports / Uses

### DB / ORM
- `SessionLocal` (passed in as `db` parameter from callers)
- `Credential`, `Device`, `Port`, `TopologyLink`, `SnmpProfile`, `AppSetting`
- `ScanRun`, `ScanRunSwitchMetric` (via `_persist_scan_run`)

### Schemas
- `ScanResult`, `ScanSwitchMetric`

### snmp_scanner
- `scan_switch` — async per-switch SNMP collector
- `auto_layout` — place new devices on map grid
- `extract_model` — extract model string from sysDescr
- `is_virtual` — skip virtual/loopback interfaces
- `speed_label` — format speed for topology links

### Globals / helpers from same file
- `_log_event`, `_read_scan_settings`, `_read_discovery_ranges`, `_expand_ranges_to_ips`
- `_persist_scan_run`, `_canonical_link_key`, `_safe_json_list`
- `_read_dns_settings`, `_resolve_host`, `_resolve_ip`
- `_build_ping_cmd` (called inside the inner `_ping_host_async`)

---

## 6. `_background_scheduler` — What It Imports / Uses

- `SessionLocal` — creates fresh DB sessions per scan cycle
- `asyncio.new_event_loop` — creates a new event loop per scan in the non-async thread
- `_execute_scan` — the core scan coroutine
- `_log_event` — structured logging
- `AppSetting` — reads `discovery_interval_sec`, `link_update_interval_sec`, `mac_update_interval_sec`, `port_update_interval_sec`
- `time.sleep(5)` — polling sleep

---

## 7. Suggested Clean Router File Structure

```
backend/
├── main.py                     # app factory only: create FastAPI, apply middleware,
│                               # include routers, call on_startup, start scheduler thread
│
├── shared/
│   ├── __init__.py
│   ├── state.py                # SCAN_JOBS, SCAN_JOBS_LOCK, LOG_BUFFER, LOG_BUFFER_LOCK, _log_event()
│   ├── auth.py                 # SECRET_TOKEN, _bearer, _require_auth()
│   └── file_settings.py        # MAP_BG_DIR, MAP_BG_FILENAME, ALLOWED_*, MAX_FILE_SIZE,
│                               # *_SETTINGS_PATH, DEFAULT_*, _read/write_map/scan/dns_settings,
│                               # _normalize_scan_settings, _normalize_dns_servers,
│                               # _find_bg_file, _clear_bg_files
│
├── scan_engine.py              # _execute_scan, _run_scan_job, _start_job,
│                               # _read_discovery_ranges, _expand_ranges_to_ips,
│                               # _persist_scan_run, _canonical_link_key, _safe_json_list,
│                               # _resolve_ip, _resolve_host, _build_ping_cmd, _ping_host,
│                               # _background_scheduler
│
├── routers/
│   ├── __init__.py
│   ├── health.py               # GET /health
│   ├── settings.py             # GET+PUT /api/settings, GET /api/stats
│   ├── credentials.py          # CRUD /api/credentials
│   ├── snmp_profiles.py        # CRUD /api/snmp-profiles
│   ├── racks.py                # CRUD /api/racks
│   ├── switch_classes.py       # CRUD /api/switch-classes
│   ├── switch_models.py        # CRUD /api/switch-models
│   ├── scan.py                 # POST /api/scan, /api/scan/jobs*, /api/scan/dry-run/jobs
│   ├── scan_runs.py            # GET /api/scan-runs
│   ├── topology.py             # GET /api/topology, PATCH position/meta
│   ├── map_bg.py               # POST+GET+DELETE /api/map-background,
│   │                           # GET+PUT /api/map-settings
│   ├── scan_settings.py        # GET+PUT /api/scan-settings,
│   │                           # GET+PUT /api/discovery-ranges,
│   │                           # GET+PUT /api/dns-settings
│   ├── bulk.py                 # GET /api/bulk-export, POST /api/bulk-import,
│   │                           # helpers: _parse/validate/serialize_bulk_rows,
│   │                           # _normalize_bool, _normalize_optional_int,
│   │                           # PROFILE_BULK_FIELDS, CREDENTIAL_BULK_FIELDS
│   └── config.py               # GET /api/config/export, POST /api/config/import
│
├── database.py                 # (unchanged)
├── schemas.py                  # (unchanged)
└── snmp_scanner.py             # (unchanged)
```

### Where Each Existing Route Goes

| Current location | Router file |
|-----------------|-------------|
| `GET /health` | `routers/health.py` |
| `GET /api/settings`, `PUT /api/settings/{key}` | `routers/settings.py` |
| `GET /api/stats` | `routers/settings.py` |
| `GET /api/bulk-export/{kind}` | `routers/bulk.py` |
| `POST /api/bulk-import/{kind}` | `routers/bulk.py` |
| `GET /api/config/export` | `routers/config.py` |
| `POST /api/config/import` | `routers/config.py` |
| `GET+POST+PUT+DELETE /api/snmp-profiles/*` | `routers/snmp_profiles.py` |
| `GET+POST+PUT+DELETE /api/racks/*` | `routers/racks.py` |
| `GET+POST+PUT+DELETE /api/switch-classes/*` | `routers/switch_classes.py` |
| `GET+POST+PUT+DELETE /api/switch-models/*` | `routers/switch_models.py` |
| `GET+POST+PUT+DELETE /api/credentials/*` | `routers/credentials.py` |
| `POST /api/scan` | `routers/scan.py` |
| `POST+GET+POST /api/scan/jobs*` | `routers/scan.py` |
| `POST /api/scan/dry-run/jobs` | `routers/scan.py` |
| `GET /api/scan-runs` | `routers/scan_runs.py` |
| `GET /api/topology` | `routers/topology.py` |
| `PATCH /api/topology/devices/*/position` | `routers/topology.py` |
| `PATCH /api/topology/racks/*/position` | `routers/topology.py` |
| `PATCH /api/topology/devices/*/meta` | `routers/topology.py` |
| `POST+GET+DELETE /api/map-background` | `routers/map_bg.py` |
| `GET+PUT /api/map-settings` | `routers/map_bg.py` |
| `GET+PUT /api/scan-settings` | `routers/scan_settings.py` |
| `GET+PUT /api/discovery-ranges` | `routers/scan_settings.py` |
| `GET+PUT /api/dns-settings` | `routers/scan_settings.py` |
| `GET /api/logs` | `routers/logs.py` |

---

## 8. Circular Dependency Risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| `scan.py` ↔ `scan_engine.py` | `scan.py` imports `_execute_scan`, `_start_job`; `scan_engine.py` imports `shared/state.py` (for `_log_event`, `SCAN_JOBS`, `SCAN_JOBS_LOCK`) — **no cycle** as long as `shared/state.py` does not import from any router | Put all shared mutable state in `shared/state.py` with zero imports from routers |
| `scan_engine.py` ↔ `routers/scan_settings.py` | `_execute_scan` calls `_read_scan_settings` and `_read_dns_settings` | Move those helpers + their constants to `shared/file_settings.py`; both `scan_engine.py` and `routers/scan_settings.py` import from there |
| `config.py` / `bulk.py` ↔ `credentials.py` / `snmp_profiles.py` | Config import route uses `CredentialCreate`, `SnmpProfileCreate` and DB models directly — no function calls to other routers, so no cycle | Both import from `database` and `schemas` — safe |
| `topology.py` ↔ `racks.py` / `switch_classes.py` / `switch_models.py` | `update_device_meta` validates referenced rack/class/model existence — does DB queries directly, does not call other router functions | No circular dep risk |
| `main.py` ↔ `scan_engine.py` | `main.py` calls `_background_scheduler()` in `on_startup`; `scan_engine.py` needs `SessionLocal` from `database` (not from `main.py`) | `scan_engine.py` imports `SessionLocal` directly from `database`; `main.py` imports `_background_scheduler` from `scan_engine` — **no cycle** |
| `shared/auth.py` ↔ `main.py` | `app` instance lives in `main.py`; `_require_auth` is a plain dependency function that doesn't import `app` | Move `_require_auth`, `_bearer`, `SECRET_TOKEN` to `shared/auth.py`; `main.py` sets `dependencies=[Depends(_require_auth)]` at app construction — **no cycle** |

---

## 9. Shared State / Globals That Need a Separate Module

These **must** be extracted to avoid every router importing from `main.py` (which would create a cycle):

### `shared/state.py`
```python
# In-process log buffer (single-worker constraint)
LOG_BUFFER: deque = deque(maxlen=5000)
LOG_BUFFER_LOCK: threading.Lock = threading.Lock()

# Background scan job registry
SCAN_JOBS: Dict[str, dict] = {}
SCAN_JOBS_LOCK: threading.Lock = threading.Lock()

def _log_event(level: int, event: str, **fields): ...
```

### `shared/auth.py`
```python
SECRET_TOKEN = os.getenv("SECRET_TOKEN", "")
_bearer = HTTPBearer(auto_error=False)

def _require_auth(credentials: HTTPAuthorizationCredentials = Security(_bearer)): ...
```

### `shared/file_settings.py`
```python
MAP_BG_DIR = "/data"
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = { ... }
ALLOWED_IMAGE_TYPES = { ... }
MAX_FILE_SIZE = 20 * 1024 * 1024

MAP_SETTINGS_PATH = ...
DEFAULT_MAP_SETTINGS = { ... }
SCAN_SETTINGS_PATH = ...
DEFAULT_SCAN_SETTINGS = { ... }
DNS_SETTINGS_PATH = ...
DEFAULT_DNS_SETTINGS = { ... }

def _find_bg_file(): ...
def _clear_bg_files(): ...
def _read_map_settings(): ...
def _write_map_settings(data): ...
def _normalize_scan_settings(value): ...
def _read_scan_settings(): ...
def _write_scan_settings(value): ...
def _normalize_dns_servers(value): ...
def _read_dns_settings(): ...
def _write_dns_settings(servers): ...
```

---

## 10. Summary of Findings

- `main.py` is a monolithic FastAPI application of **2123 lines** with **~45 route handler functions**, **~30 helper/utility functions**, and **2 long-running background functions** (`_execute_scan` at ~400 lines, `_background_scheduler` at ~60 lines).
- The file mixes HTTP routing, scan engine orchestration, DNS/ping utilities, file-system persistence, and in-process shared state in a single namespace.
- The cleanest split is into **14 router or support files** (see section 7), anchored by a thin `main.py` that only wires up the `FastAPI` app.
- The **only real circular dependency risk** lies in shared mutable state (`SCAN_JOBS`, `LOG_BUFFER`) and shared helpers (`_log_event`, `_read_scan_settings`, `_read_dns_settings`) — all safely resolved by introducing `shared/state.py`, `shared/auth.py`, and `shared/file_settings.py` as leaf modules with no imports from any router.
- `scan_engine.py` is the most import-heavy module and must import from `database`, `schemas`, `snmp_scanner`, `shared/state.py`, and `shared/file_settings.py` — all of which are leaf modules, so no cycle is introduced.

**Document path:** `docs/SubAgent/MAIN_SPLIT_ANALYSIS.md`
