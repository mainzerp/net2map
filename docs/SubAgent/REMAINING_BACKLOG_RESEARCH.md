# Remaining Backlog Items -- Research & Analysis

**Date:** 2026-03-20
**Source:** NetMap Code Review (CODE_REVIEW_ANALYSIS.md / CODE_REVIEW_PLAN.md)
**Scope:** CQ-2, CQ-8, PC-2, AD-2, Frontend CSS, TypeScript migration

---

## Table of Contents

1. [Scan Engine Modularization (CQ-2)](#1-scan-engine-modularization-cq-2)
2. [Scanner Plugin Discovery (CQ-8)](#2-scanner-plugin-discovery-cq-8)
3. [N+1 Query Reduction in Topology (PC-2)](#3-n1-query-reduction-in-topology-pc-2)
4. [Celery Beat Scheduler Migration (AD-2)](#4-celery-beat-scheduler-migration-ad-2)
5. [Frontend CSS Architecture](#5-frontend-css-architecture)
6. [TypeScript Migration](#6-typescript-migration)
7. [Implementation Order Recommendation](#7-implementation-order-recommendation)

---

## 1. Scan Engine Modularization (CQ-2)

### Current State

`backend/scan_engine.py` is a single 1,310-line file containing 18 functions spanning 8 distinct responsibility areas. It is the largest file in the codebase and the hardest to reason about.

### Identified Logical Boundaries

#### Module A: `scan_engine/broadcast.py` -- WebSocket Broadcasting

| Function | Lines | Description |
|----------|-------|-------------|
| `_broadcast_progress()` | 35-49 | Fire-and-forget scan progress to WS clients |
| `_broadcast_scan_complete()` | 51-66 | Fire-and-forget scan completion to WS clients |

**Imports needed:** `routers.ws.broadcast_scan_update_sync` (lazy import, already deferred)
**Public API:** `broadcast_progress(scanned, total, latest_ip, success, job_id)`, `broadcast_scan_complete(job_id, status, found, links, duration_ms)`
**Cross-module deps:** Used by the core scan executor; calls into `routers.ws`
**Circular import risk:** LOW -- these already use lazy imports inside try/except blocks

#### Module B: `scan_engine/event_loop.py` -- Background Event Loop

| Function/Object | Lines | Description |
|-----------------|-------|-------------|
| `_bg_loop` (global) | 70-72 | Shared asyncio loop variable |
| `_bg_loop_lock` | 73 | Thread lock |
| `_get_bg_loop()` | 75-92 | Lazy background event loop creation |

**Imports needed:** `asyncio`, `threading`
**Public API:** `get_bg_loop() -> asyncio.AbstractEventLoop`
**Cross-module deps:** Used by `routers/ws.py` (lazy import: `from scan_engine import _get_bg_loop`), job management, and scheduler
**Circular import risk:** LOW -- pure infrastructure, no domain imports. `routers/ws.py` already lazy-imports this.

#### Module C: `scan_engine/ping.py` -- Ping Utilities

| Function | Lines | Description |
|----------|-------|-------------|
| `_build_ping_cmd()` | 97-100 | Platform-specific ping command builder |
| `_ping_host()` | 103-141 | Synchronous ICMP ping |

Note: `_ping_host_async()` (lines 508-538) is defined inline inside `_execute_scan` as a nested async function. It duplicates `_build_ping_cmd` logic. This should be extracted to this module as well.

**Imports needed:** `platform`, `re`, `subprocess`, `asyncio`
**Public API:** `build_ping_cmd(ip, timeout)`, `ping_host(ip, timeout) -> (bool, int)`, `ping_host_async(ip, timeout) -> (bool, int)`
**Cross-module deps:** None -- standalone utility
**Circular import risk:** NONE

#### Module D: `scan_engine/dns.py` -- DNS Resolution & Caching

| Function/Object | Lines | Description |
|-----------------|-------|-------------|
| `_DNS_CACHE_MAX` | 237 | Cache size limit constant |
| `_evict_dns_cache()` | 240-245 | LRU-style cache eviction |
| `_resolve_host()` | 249-305 | Reverse DNS with cache + custom nameservers |
| `_resolve_ip()` | 226-234 | Forward name resolution from scan batch |

**Imports needed:** `socket`, `logging`, `shared.state._log_event`; optional `dns.resolver`, `dns.reversename`
**Public API:** `resolve_host(ip, cache, dns_servers, correlation_id) -> str`, `resolve_ip(sys_name, switch_data) -> str`
**Cross-module deps:** `shared.state._log_event` for structured logging
**Circular import risk:** NONE

#### Module E: `scan_engine/db_helpers.py` -- Database Write Utilities

| Function | Lines | Description |
|----------|-------|-------------|
| `_safe_json_list()` | 145-153 | Parse JSON list from string |
| `_canonical_link_key()` | 157-158 | Build normalized link identifier |
| `_persist_scan_run()` | 161-186 | Write ScanRun + metrics to DB |
| `_read_discovery_ranges()` | 190-202 | Read discovery ranges from AppSettings |
| `_expand_ranges_to_ips()` | 204-223 | Expand CIDR ranges to IP list |

**Imports needed:** `json`, `ipaddress`, `logging`, `sqlalchemy.orm.Session`, `database.*` models, `schemas.ScanResult`
**Public API:** `safe_json_list(raw)`, `canonical_link_key(...)`, `persist_scan_run(db, result, ...)`, `read_discovery_ranges(db)`, `expand_ranges_to_ips(ranges)`
**Cross-module deps:** `database` models, `schemas`
**Circular import risk:** NONE -- only imports from `database` and `schemas`
**External consumers:** `routers/scan_settings.py` imports `_read_discovery_ranges`, `routers/scan_runs.py` imports `_safe_json_list`

#### Module F: `scan_engine/executor.py` -- Core Scan Execution (the big one)

| Function | Lines | Description |
|----------|-------|-------------|
| `_execute_scan()` | 325-1118 | The ~800-line main scan coroutine |

This is the heart of the engine. It handles:
- Credential grouping and fallback logic (lines 340-420)
- Range-based discovery probe preparation (lines 370-440)
- Async target scanning with semaphore (inner function `_scan_target_async`, lines 540-610)
- Result aggregation and progress broadcasting (lines 620-690)
- Dry-run preview generation (lines 700-760)
- Auto-credential creation for discovered IPs (lines 770-810)
- Device upsert (lines 810-870)
- Port/endpoint update (lines 880-960)
- Link/LLDP update with port name resolution (lines 960-1070)
- Scan run persistence and metrics (lines 1080-1118)

**Imports needed:** Everything -- this is the integration point
**Public API:** `execute_scan(db, cancel_event, correlation_id, scan_type, dry_run) -> ScanResult`
**Cross-module deps:** All other modules (A through E), plus `routers.topology._bump_topo_version` (lazy import at line 1106)
**Circular import risk:** MEDIUM -- lazy imports from `routers.topology` (line 1106) and `routers.ws` (via broadcast module A). Both are already deferred with `from ... import ...` inside function bodies.

**Refactoring opportunity within executor:**
The port update block (lines 880-960) and link update block (lines 960-1070) could be extracted as `_update_ports(db, switch_data, ...)` and `_update_links(db, switch_data, ...)` subfunctions within the executor module, reducing `_execute_scan` from ~800 to ~400 lines.

#### Module G: `scan_engine/jobs.py` -- Job Management

| Function | Lines | Description |
|----------|-------|-------------|
| `_run_scan_job()` | 1122-1157 | Thread-based scan execution wrapper |
| `_start_job()` | 1160-1207 | Job dispatcher (Celery or thread fallback) |

**Imports needed:** `threading`, `uuid`, `datetime`, `shared.state.*`, `shared.redis_client`, `schemas.ScanResult`; lazy: `tasks.run_scan_task`
**Public API:** `start_job(dry_run, scan_type) -> dict`
**Cross-module deps:** Module F (`_execute_scan`), Module B (`_get_bg_loop`), `shared.state.*`, `tasks.run_scan_task` (lazy)
**Circular import risk:** LOW -- already uses lazy import for `tasks.run_scan_task`

#### Module H: `scan_engine/scheduler.py` -- Background Scheduler

| Function/Object | Lines | Description |
|-----------------|-------|-------------|
| `_scheduler_wake` | 1213 | Threading event for early wake |
| `_dispatch_scheduled_scan()` | 1216-1254 | Dispatch scan with lock checking |
| `_background_scheduler()` | 1260-1310 | Main scheduler loop |

**Imports needed:** `threading`, `time`, `uuid`, `logging`, `database.SessionLocal`, `database.AppSetting`, `shared.state.*`
**Public API:** `background_scheduler()`, `scheduler_wake` (event object for settings changes)
**Cross-module deps:** Module F (`_execute_scan`), Module B (`_get_bg_loop`), `shared.state`, lazy: `tasks.run_scan_task`
**Circular import risk:** LOW

### Circular Import Analysis

The dangerous circular import paths are:

1. **scan_engine -> routers.ws -> scan_engine**: `_broadcast_progress` lazy-imports `routers.ws.broadcast_scan_update_sync`, and `routers/ws.py` lazy-imports `scan_engine._get_bg_loop`. Both are already lazy (deferred inside function bodies), so splitting into modules does not change the risk as long as the lazy pattern is preserved.

2. **scan_engine -> routers.topology**: `_execute_scan` lazy-imports `routers.topology._bump_topo_version` at line 1106. This becomes `scan_engine.executor` -> `routers.topology` which is fine (one-directional).

**Resolution strategy:**
- Extract `_get_bg_loop` to `scan_engine/event_loop.py`. Update `routers/ws.py` to import from `scan_engine.event_loop` instead of `scan_engine`.
- Keep lazy imports inside function bodies for `routers.ws` and `routers.topology` references.
- Create `scan_engine/__init__.py` that re-exports the public API for backward compatibility, so existing imports like `from scan_engine import _start_job` continue to work during the transition.

### Proposed Package Structure

```
backend/scan_engine/
    __init__.py          # Re-exports public API for backward compat
    broadcast.py         # Module A: WS broadcasting (15 lines)
    event_loop.py        # Module B: Background asyncio loop (25 lines)
    ping.py              # Module C: Ping utilities (60 lines)
    dns.py               # Module D: DNS resolution & caching (80 lines)
    db_helpers.py        # Module E: DB write utilities (80 lines)
    executor.py          # Module F: Core _execute_scan (800 lines)
    jobs.py              # Module G: Job management (50 lines)
    scheduler.py         # Module H: Background scheduler (55 lines)
```

### External Import Updates Required

After modularization, these files need import path updates:

| File | Current Import | New Import |
|------|---------------|------------|
| `main.py` | `from scan_engine import _background_scheduler` | `from scan_engine import _background_scheduler` (via `__init__` re-export) |
| `tasks.py` | `from scan_engine import _execute_scan` | `from scan_engine import _execute_scan` (via `__init__` re-export) |
| `routers/scan.py` | `from scan_engine import _execute_scan, _start_job` | No change (re-exported) |
| `routers/scan_settings.py` | `from scan_engine import _read_discovery_ranges` | No change (re-exported) |
| `routers/scan_runs.py` | `from scan_engine import _safe_json_list` | No change (re-exported) |
| `routers/ws.py` | `from scan_engine import _get_bg_loop` | No change (re-exported) |

The `__init__.py` re-export strategy means **zero breaking changes** for external consumers.

### Effort Estimate

- Lines of code to move: ~1,310
- New boilerplate (`__init__.py`, imports): ~40 lines
- External import updates: 0 (handled by re-exports)
- Test updates: Verify existing tests still pass (no test changes expected)
- Risk: LOW (mechanical restructuring with re-export safety net)

---

## 2. Scanner Plugin Discovery (CQ-8)

### Current State

`backend/scanners/__init__.py` is a manual registry:

```python
SCANNER_REGISTRY = {
    "aruba_cx": ArubaCXScanner,
    "fs":       FSScanner,
    "unifi":    UniFiScanner,
    "opnsense": OPNsenseScanner,
    "generic":  GenericScanner,
}
```

Every new scanner requires:
1. Creating the scanner file in `scanners/`
2. Adding an import to `__init__.py`
3. Adding an entry to `SCANNER_REGISTRY`

### Scanner Interface Analysis

All scanners implement `VendorScanner` (ABC) with 3 methods:
- `extract_model(sys_descr: str) -> str`
- `is_virtual_port(if_descr: str) -> bool`
- `fdb_strategy() -> str` (returns `"dot1d"` or `"qbridge"`)

Each scanner file is small (20-35 lines) and self-contained. No scanner imports from another scanner.

### Recommended Approach: `__init_subclass__` Pattern

This is the cleanest approach for this codebase. It requires no external dependencies and leverages Python's built-in metaclass machinery.

**Changes to `base.py`:**

```python
class VendorScanner(ABC):
    """Base class that every vendor scanner must implement."""
    _registry: dict[str, type["VendorScanner"]] = {}
    vendor_id: str = ""  # Must be set by subclasses

    def __init_subclass__(cls, vendor_id: str = "", **kwargs):
        super().__init_subclass__(**kwargs)
        if vendor_id:
            cls.vendor_id = vendor_id
            VendorScanner._registry[vendor_id] = cls

    @abstractmethod
    def extract_model(self, sys_descr: str) -> str: ...
    @abstractmethod
    def is_virtual_port(self, if_descr: str) -> bool: ...
    @abstractmethod
    def fdb_strategy(self) -> str: ...
```

**Changes to scanner classes:**

```python
class ArubaCXScanner(VendorScanner, vendor_id="aruba_cx"):
    ...
```

**Changes to `__init__.py`:**

```python
"""Vendor scanner plugin registry with auto-discovery."""
import importlib
import pkgutil
from pathlib import Path
from scanners.base import VendorScanner

# Auto-import all modules in the scanners package to trigger __init_subclass__
_pkg_path = str(Path(__file__).parent)
for _importer, _modname, _ispkg in pkgutil.iter_modules([_pkg_path]):
    if _modname != "base":
        importlib.import_module(f"scanners.{_modname}")

# Expose registry and lookup function
SCANNER_REGISTRY = VendorScanner._registry
_scanner_cache: dict[str, VendorScanner] = {}

def get_scanner(vendor: str) -> VendorScanner:
    if vendor not in _scanner_cache:
        cls = SCANNER_REGISTRY.get(vendor) or SCANNER_REGISTRY.get("generic")
        _scanner_cache[vendor] = cls()
    return _scanner_cache[vendor]
```

**Adding a new scanner after this change:**
1. Create `scanners/my_vendor.py` with `class MyVendorScanner(VendorScanner, vendor_id="my_vendor"): ...`
2. Done. No other files need editing.

### Alternative Considered: Directory Scan Only

A simpler approach using just `pkgutil` + manual `SCANNER_REGISTRY` dict in each file. Rejected because `__init_subclass__` is more Pythonic, requires less boilerplate per scanner, and the registration is co-located with the class definition.

### Effort Estimate

- Modify: `scanners/base.py` (add 8 lines)
- Modify: `scanners/__init__.py` (replace 15 lines with 15 lines)
- Modify: Each scanner file (add `vendor_id="..."` to class declaration -- 1-line change each, 5 files)
- Risk: LOW

---

## 3. N+1 Query Reduction in Topology (PC-2)

### Current State -- `get_topology` Endpoint

```python
cred_ips = {c.ip for c in db.query(Credential.ip).all()}          # Query 1
nodes   = db.query(Device).filter(...).all()                       # Query 2
links   = db.query(TopologyLink).all()                             # Query 3
racks   = db.query(RackModel).order_by(RackModel.id).all()         # Query 4
classes = db.query(SwitchClassModel).order_by(...).all()            # Query 5
models  = db.query(SwitchModelModel).order_by(...).all()            # Query 6
```

This is **6 queries** but they are all independent top-level queries, not N+1. The topology endpoint is actually well-structured -- it fetches all data in 6 flat queries and joins in Python. With ETag caching and Redis-backed version tracking, this endpoint is already optimized for the common case (cache hit = 0 queries).

**Assessment: The `get_topology` endpoint does NOT have an N+1 problem.**

### Current State -- `list_all_devices` Endpoint

```python
query = db.query(Device)                                           # Query 1
devices = query.order_by(Device.ip).all()
models  = db.query(SwitchModelModel).all()                         # Query 2
# Then for found_on lookup:
matching_ports = (
    db.query(PortModel, Device)
    .join(Device, Device.id == PortModel.device_id)
    .filter(PortModel.peer_ip.in_(device_ips))
    .all()
)                                                                   # Query 3
```

This is **3 queries**. Again, not N+1, but the `Credential.ip` subquery for role filtering adds a 4th:

```python
cred_ips = {c.ip for c in db.query(Credential.ip).all()}           # Query 4
```

**Assessment: The `list_all_devices` endpoint also does NOT have an N+1 problem.** The queries are flat and batch-oriented.

### Actual Optimization Opportunities

1. **Combine credential IP + device query** using a subquery or join:
```python
# Instead of:
cred_ips = {c.ip for c in db.query(Credential.ip).all()}
nodes = db.query(Device).filter(Device.ip.in_(cred_ips))

# Use:
cred_subq = db.query(Credential.ip).subquery()
nodes = db.query(Device).filter(Device.ip.in_(db.query(cred_subq)))
```
This eliminates one round-trip and avoids materializing the full credential IP set in Python.

2. **The `found_on` lookup in `list_all_devices`** uses `PortModel.peer_ip.in_(device_ips)` which can be a large IN clause for big networks. Could be optimized with a lateral join or CTE, but the current approach is reasonable for typical network sizes (< 1000 devices).

3. **Device.ports relationship** is not eagerly loaded in `get_topology`, which is fine because `DeviceOut` includes ports via Pydantic `model_validate`. However, if SQLAlchemy lazy-loads ports for each device during serialization, that would be N+1. Need to verify whether `DeviceOut.model_validate(d)` triggers lazy loading of `d.ports`.

**Verdict:** Check if `Device` has a `ports` relationship that gets lazy-loaded. If so, add `joinedload(Device.ports)` to the `get_topology` query. Otherwise, the topology queries are already efficient.

### Effort Estimate

- Low-impact optimization: Replace `{c.ip for c in db.query(Credential.ip).all()}` with subquery (2 locations)
- Potentially significant: Add `joinedload(Device.ports)` if lazy loading is confirmed (1 line change per query)
- Risk: LOW

---

## 4. Celery Beat Scheduler Migration (AD-2)

### Current State

The background scheduler is a manually-implemented polling loop in `scan_engine.py` lines 1260-1310:

```python
def _background_scheduler():
    while True:
        _scheduler_wake.wait(timeout=5)
        _scheduler_wake.clear()
        # Read settings from DB
        # Check intervals
        # Dispatch scans
```

It runs as a daemon thread started from `main.py` lifespan:
```python
threading.Thread(target=_background_scheduler, daemon=True).start()
```

It supports 3 scan types with independent intervals: `macs`, `links`, `discovery`.

### Current Celery Configuration

`celery_app.py` is minimal (18 lines):
- Configures Celery with Redis broker/backend
- Includes `tasks` module
- No beat schedule

### What Would Need to Change

**Option A: Celery Beat with Database Scheduler**

Replace `_background_scheduler` with `celery.beat.Scheduler` using `django-celery-beat` style database-backed schedule. However, this project uses SQLAlchemy not Django, so we'd need `celery-sqlalchemy-scheduler` or implement a custom scheduler.

Complexity: HIGH. Requires new dependency, schema changes, admin UI for schedule management.

**Option B: Celery Beat with Static Schedule + Dynamic Interval**

Use `celery_app.conf.beat_schedule` with a single periodic task that reads intervals from the DB and dispatches scans accordingly. This is simpler but still requires running `celery beat` as a separate process.

```python
celery_app.conf.beat_schedule = {
    "scheduler-tick": {
        "task": "tasks.scheduler_tick",
        "schedule": 5.0,  # Check every 5 seconds (matches current behavior)
    },
}
```

```python
# In tasks.py:
@celery_app.task
def scheduler_tick():
    """Replaces _background_scheduler's loop body."""
    # Read settings, check intervals, dispatch scans
    ...
```

Complexity: MEDIUM. Requires a new Celery task, running `celery beat` alongside the worker.

**Option C: Keep Current Implementation, Improve It**

The current scheduler works correctly and has several advantages:
- No additional process to manage
- Supports `_scheduler_wake` for immediate interval re-evaluation
- Already dispatches to Celery when available, falls back to direct execution

The main concern (from the code review) was that this pattern doesn't scale well with multiple web server processes. However, with the distributed scan lock already in place via Redis (`can_dispatch_scan`, `acquire_scan_lock`), duplicate dispatches are prevented.

### Dependency on CQ-2

If the scan engine is modularized first (CQ-2), the scheduler naturally moves to `scan_engine/scheduler.py`, making it much cleaner to reason about and modify. The scheduler's imports and concerns become isolated.

### Recommendation

**Option B** is the sweet spot between complexity and value, but should wait until after CQ-2 modularization. The changes are:

1. Add a `scheduler_tick` task to `tasks.py` that contains the loop body from `_background_scheduler`
2. Configure `beat_schedule` in `celery_app.py`
3. Add `celery beat` to `docker-compose.yml`
4. Remove `_background_scheduler` thread from `main.py` lifespan (when `celery beat` is guaranteed running)
5. Keep the thread-based fallback for development without Celery

### Effort Estimate

- New code: ~40 lines (`scheduler_tick` task)
- Modified: `celery_app.py` (+5 lines), `docker-compose.yml` (+10 lines), `main.py` (-2 lines)
- Risk: MEDIUM (requires testing with Celery Beat process)

---

## 5. Frontend CSS Architecture

### Current State

The entire frontend uses **inline styles exclusively**. There are:
- Zero CSS files (no `.css`, `.module.css`, or styled-components)
- Zero `className` usage on user components
- One global `<style>` tag in `App.jsx` for resets (scrollbar, box-sizing, body background)
- One dynamically injected `<style>` in `Port.jsx` for a keyframe animation

Style patterns observed across components:

```jsx
// Typical pattern -- style objects inline
<div style={{
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: 10,
  marginBottom: 6,
}}>
```

```jsx
// Helper functions for repeated styles (CredentialsTab.jsx)
const lbl = () => ({ ... });
const inp = { ... };
const sel = { ... };
```

### Design System Observations

The codebase has an **implicit design system** with consistent values:
- Background colors: `#020817`, `#0a0e18`, `#0f172a`, `#1e293b` (dark blues)
- Text colors: `#e2e8f0`, `#94a3b8`, `#64748b`, `#475569` (grays)
- Accent: `#22d3ee` (cyan), `#38bdf8` (light blue)
- Border radius: 4, 6, 8, 10, 12
- Font: `'Inter', system-ui, sans-serif`
- Border: `1px solid #1e293b` (used everywhere)

These are Tailwind CSS color values used as raw hex codes.

### Recommended First Step: CSS Variables + Shared Style Constants

A full migration to CSS modules or styled-components would touch every component and is high-risk for a low-reward cosmetic change. Instead:

**Step 1 -- Design tokens file:**

Create `frontend/src/styles/tokens.js`:
```js
export const colors = {
  bg: { base: "#020817", card: "#0f172a", surface: "#1e293b" },
  text: { primary: "#e2e8f0", secondary: "#94a3b8", muted: "#64748b" },
  accent: { cyan: "#22d3ee", blue: "#38bdf8" },
  status: { online: "#22c55e", offline: "#f87171" },
  border: { default: "#1e293b", hover: "#334155" },
};
export const radii = { sm: 4, md: 6, lg: 8, xl: 10 };
```

**Step 2 -- Shared component styles:**

Create `frontend/src/styles/shared.js` with common style objects (button, input, label, card patterns) that are currently duplicated across 10+ components.

**Step 3 -- Incremental adoption:**

Components import from `tokens.js` instead of hardcoding hex values. This is backward-compatible and can be done one component at a time.

This approach:
- Delivers immediate value (single source of truth for colors/spacing)
- Zero risk (no build config changes, no new dependencies)
- Enables future migration to CSS modules by centralizing values first

### Effort Estimate

- `tokens.js` + `shared.js`: ~80 lines total
- Per-component update: ~10 minutes each, 20+ components
- Recommended: Create the tokens file now, migrate components incrementally
- Risk: VERY LOW

---

## 6. TypeScript Migration

### Current State

- **Build tool:** Vite 5.4 with `@vitejs/plugin-react`
- **Test tool:** Vitest 1.6 with jsdom
- **No TypeScript** anything -- no `tsconfig.json`, no `.ts`/`.tsx` files, no type-checking dependencies
- **Package count:** 5 dependencies, 5 devDependencies (lean)
- **File count:** ~30 `.jsx` files, 1 `.js` (api.js), 1 store (store.js)
- **Framework:** React 18 with zustand for state, react-router-dom v6

### Configuration Needed

1. Install: `typescript`, `@types/react`, `@types/react-dom`
2. Create `tsconfig.json` with strict settings
3. Update `vite.config.js` -- Vite handles `.tsx` natively, no plugin changes needed
4. Update `vitest.config.js` -- Vitest handles TypeScript natively

### Recommended First Step: Type-Check Infrastructure + api.js

**Step 1 -- Add TypeScript config (allow JS):**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

Key: `allowJs: true` + `checkJs: false` means existing `.jsx` files compile without errors. Only `.ts`/`.tsx` files get strict checking.

**Step 2 -- Convert `api.js` to `api.ts`:**

`api.js` is the single most impactful file to type. It defines:
- The `api` fetch wrapper with `get`, `post`, `put`, `patch`, `delete` methods
- Type constants (`VENDOR_LABEL`, `VENDOR_COLOR`, `CABLE_COLORS`)
- Utility functions (`speedLabel`, `speedColor`, `normPort`, `buildPortLinkMap`)
- Auth functions (`getStoredToken`, `getStoredUser`, `logout`)

Typing this file provides type safety for every API call across the frontend.

**Step 3 -- Convert `store.js` to `store.ts`:**

The zustand store is the second most impactful file -- it defines all global state shapes.

**Step 4 -- Add `tsc --noEmit` to CI:**

```json
"scripts": {
  "typecheck": "tsc --noEmit"
}
```

This approach:
- Does NOT require renaming any `.jsx` files initially
- Provides type-safe API layer immediately
- Can be done in < 1 hour
- Components can be migrated to `.tsx` one at a time afterward

### Effort Estimate

- TypeScript config setup: 15 minutes
- Convert `api.js` -> `api.ts`: 1-2 hours (define API response types)
- Convert `store.js` -> `store.ts`: 30 minutes
- Risk: LOW (Vite + Vitest handle TS natively, `allowJs` prevents breakage)

---

## 7. Implementation Order Recommendation

### Priority Matrix

| # | Item | Value | Effort | Dependencies | Recommendation |
|---|------|-------|--------|--------------|----------------|
| 1 | Scanner Plugin Discovery (CQ-8) | Medium | Low | None | **Do first** -- quick win, isolated change |
| 2 | N+1 Query Optimization (PC-2) | Low-Medium | Very Low | None | **Do second** -- subquery optimization is 2-line change |
| 3 | Scan Engine Modularization (CQ-2) | High | Medium | None | **Do third** -- major structural improvement, enables AD-2 |
| 4 | Frontend CSS Tokens (partial) | Medium | Low | None | **Do fourth** -- create tokens file, adopt incrementally |
| 5 | TypeScript Setup (partial) | Medium | Low | None | **Do fifth** -- config + api.ts conversion |
| 6 | Celery Beat Migration (AD-2) | Low-Medium | Medium | CQ-2 | **Do last** -- depends on modularization, lower urgency |

### Rationale

- **CQ-8 first:** Smallest, most isolated change. Proves auto-discovery pattern works before larger refactors.
- **PC-2 second:** Trivial optimization, no structural changes. Gets it off the backlog.
- **CQ-2 third:** The highest-value architectural change. Makes the codebase significantly more maintainable and unblocks AD-2.
- **CSS/TS fourth/fifth:** These are ongoing efforts with no deadline. Creating the foundation (tokens file, tsconfig) is quick and enables incremental progress.
- **AD-2 last:** Lower urgency because the current scheduler works correctly. The main benefit is operational (separate process management), which matters more at scale.

### Grouping for Implementation

**Sprint 1 (Quick wins):** CQ-8 + PC-2
**Sprint 2 (Architecture):** CQ-2
**Sprint 3 (Frontend foundation):** CSS tokens + TypeScript setup
**Sprint 4 (Infrastructure):** AD-2 Celery Beat migration
