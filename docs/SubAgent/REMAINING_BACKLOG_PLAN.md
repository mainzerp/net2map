# Remaining Backlog -- Implementation Plan

**Date:** 2026-03-20
**Source:** REMAINING_BACKLOG_RESEARCH.md
**Scope:** CQ-8, PC-2, CQ-2, AD-2, Frontend CSS Tokens, TypeScript Setup

---

## Table of Contents

1. [Step 1: Scanner Plugin Discovery (CQ-8)](#step-1-scanner-plugin-discovery-cq-8)
2. [Step 2: N+1 Query Reduction (PC-2)](#step-2-n1-query-reduction-pc-2)
3. [Step 3: Scan Engine Modularization (CQ-2)](#step-3-scan-engine-modularization-cq-2)
4. [Step 4: Celery Beat Scheduler Migration (AD-2)](#step-4-celery-beat-scheduler-migration-ad-2)
5. [Step 5: Frontend Design Tokens](#step-5-frontend-design-tokens)
6. [Step 6: TypeScript Setup](#step-6-typescript-setup)
7. [Dependencies Between Steps](#dependencies-between-steps)
8. [Breaking Changes Summary](#breaking-changes-summary)

---

## Step 1: Scanner Plugin Discovery (CQ-8)

**Goal:** Replace manual `SCANNER_REGISTRY` with `__init_subclass__` auto-discovery so adding a new scanner requires only creating one file.

**Dependencies:** None
**Breaking changes:** None (public API `get_scanner()` and `SCANNER_REGISTRY` dict remain identical)

### Files to Modify

#### 1.1 `backend/scanners/base.py`

Add `__init_subclass__` hook and `_registry` class variable to `VendorScanner`:

```python
"""Abstract base class for vendor-specific SNMP scanners."""
from abc import ABC, abstractmethod


class VendorScanner(ABC):
    """Base class that every vendor scanner must implement."""
    _registry: dict[str, type["VendorScanner"]] = {}
    vendor_id: str = ""

    def __init_subclass__(cls, vendor_id: str = "", **kwargs):
        super().__init_subclass__(**kwargs)
        if vendor_id:
            cls.vendor_id = vendor_id
            VendorScanner._registry[vendor_id] = cls

    @abstractmethod
    def extract_model(self, sys_descr: str) -> str:
        """Extract the device model string from sysDescr."""

    @abstractmethod
    def is_virtual_port(self, if_descr: str) -> bool:
        """Return True if the interface is virtual / should be filtered out."""

    @abstractmethod
    def fdb_strategy(self) -> str:
        """Return the FDB walk strategy: 'dot1d' or 'qbridge'."""
```

Changes:
- Add `_registry: dict[str, type["VendorScanner"]] = {}` class variable
- Add `vendor_id: str = ""` class variable
- Add `__init_subclass__(cls, vendor_id: str = "", **kwargs)` method (6 lines)

#### 1.2 `backend/scanners/aruba_cx.py`

Change class declaration from:
```python
class ArubaCXScanner(VendorScanner):
```
To:
```python
class ArubaCXScanner(VendorScanner, vendor_id="aruba_cx"):
```

#### 1.3 `backend/scanners/fs_scanner.py`

Change class declaration from:
```python
class FSScanner(VendorScanner):
```
To:
```python
class FSScanner(VendorScanner, vendor_id="fs"):
```

#### 1.4 `backend/scanners/unifi.py`

Change class declaration from:
```python
class UniFiScanner(VendorScanner):
```
To:
```python
class UniFiScanner(VendorScanner, vendor_id="unifi"):
```

#### 1.5 `backend/scanners/opnsense.py`

Change class declaration from:
```python
class OPNsenseScanner(VendorScanner):
```
To:
```python
class OPNsenseScanner(VendorScanner, vendor_id="opnsense"):
```

#### 1.6 `backend/scanners/generic.py`

Change class declaration from:
```python
class GenericScanner(VendorScanner):
```
To:
```python
class GenericScanner(VendorScanner, vendor_id="generic"):
```

#### 1.7 `backend/scanners/__init__.py`

Replace entire file with auto-discovery logic:

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

SCANNER_REGISTRY = VendorScanner._registry

_scanner_cache: dict[str, VendorScanner] = {}


def get_scanner(vendor: str) -> VendorScanner:
    """Return a scanner instance for the given vendor (cached singletons)."""
    if vendor not in _scanner_cache:
        cls = SCANNER_REGISTRY.get(vendor) or SCANNER_REGISTRY.get("generic")
        _scanner_cache[vendor] = cls()
    return _scanner_cache[vendor]
```

Changes:
- Remove all 5 explicit scanner imports
- Add `importlib`, `pkgutil`, `Path` imports
- Add auto-discovery loop (3 lines)
- Set `SCANNER_REGISTRY = VendorScanner._registry`
- `get_scanner()` fallback changes from `GenericScanner` class reference to `SCANNER_REGISTRY.get("generic")` (now resolved via registry)

### Checklist

- [ ] 1.1 Add `_registry`, `vendor_id`, `__init_subclass__` to `VendorScanner` in `base.py`
- [ ] 1.2 Add `vendor_id="aruba_cx"` to `ArubaCXScanner` class declaration
- [ ] 1.3 Add `vendor_id="fs"` to `FSScanner` class declaration
- [ ] 1.4 Add `vendor_id="unifi"` to `UniFiScanner` class declaration
- [ ] 1.5 Add `vendor_id="opnsense"` to `OPNsenseScanner` class declaration
- [ ] 1.6 Add `vendor_id="generic"` to `GenericScanner` class declaration
- [ ] 1.7 Replace `__init__.py` with auto-discovery logic
- [ ] 1.8 Run existing tests: `python -m pytest tests/ -v`
- [ ] 1.9 Verify `SCANNER_REGISTRY` has all 5 entries: `python -c "from scanners import SCANNER_REGISTRY; print(SCANNER_REGISTRY)"`

---

## Step 2: N+1 Query Reduction (PC-2)

**Goal:** Replace the `{c.ip for c in db.query(Credential.ip).all()}` pattern with a subquery to eliminate one DB round-trip and avoid materializing the full set in Python.

**Dependencies:** None
**Breaking changes:** None

### Files to Modify

#### 2.1 `backend/routers/topology.py` -- `get_topology()` (line 95-98)

Change from:
```python
    cred_ips = {c.ip for c in db.query(Credential.ip).all()}
    nodes   = db.query(Device).filter(
        Device.ignored == False,
        Device.ip.in_(cred_ips),
    ).all()
```

To:
```python
    cred_ip_subq = db.query(Credential.ip).subquery()
    nodes   = db.query(Device).filter(
        Device.ignored == False,
        Device.ip.in_(db.query(cred_ip_subq.c.ip)),
    ).all()
```

This pushes the credential IP filter into a single SQL query with a subselect instead of two round-trips.

#### 2.2 `backend/routers/topology.py` -- `list_all_devices()` (lines 253-257)

Change from:
```python
        cred_ips = {c.ip for c in db.query(Credential.ip).all()}
        if role == "network":
            query = query.filter(Device.ip.in_(cred_ips))
        else:
            query = query.filter(~Device.ip.in_(cred_ips))
```

To:
```python
        cred_ip_subq = db.query(Credential.ip).subquery()
        if role == "network":
            query = query.filter(Device.ip.in_(db.query(cred_ip_subq.c.ip)))
        else:
            query = query.filter(~Device.ip.in_(db.query(cred_ip_subq.c.ip)))
```

### Checklist

- [ ] 2.1 Replace `cred_ips` set with subquery in `get_topology()` (~line 95)
- [ ] 2.2 Replace `cred_ips` set with subquery in `list_all_devices()` (~line 253)
- [ ] 2.3 Run existing tests: `python -m pytest tests/ -v`
- [ ] 2.4 Manual verification: hit `GET /api/topology` and `GET /api/devices?role=network` and confirm identical results

---

## Step 3: Scan Engine Modularization (CQ-2)

**Goal:** Split `backend/scan_engine.py` (1,310 lines, 18 functions) into a `scan_engine/` package with 8 focused modules. Zero breaking changes for external consumers via `__init__.py` re-exports.

**Dependencies:** Steps 1-2 should be completed first (to avoid merge conflicts), but there is no functional dependency.
**Breaking changes:** None (all existing imports continue to work via `__init__.py` re-exports)

### Overview of Function Movements

| Current Location | Target Module | Functions/Objects |
|------------------|---------------|-------------------|
| `scan_engine.py` lines 35-66 | `scan_engine/broadcast.py` | `_broadcast_progress()`, `_broadcast_scan_complete()` |
| `scan_engine.py` lines 70-92 | `scan_engine/event_loop.py` | `_bg_loop`, `_bg_loop_lock`, `_get_bg_loop()` |
| `scan_engine.py` lines 97-141 | `scan_engine/ping.py` | `_build_ping_cmd()`, `_ping_host()` |
| `scan_engine.py` lines 145-305 | `scan_engine/dns.py` | `_safe_json_list()`, `_canonical_link_key()`, `_DNS_CACHE_MAX`, `_evict_dns_cache()`, `_resolve_host()`, `_resolve_ip()` |
| `scan_engine.py` lines 161-223 | `scan_engine/db_helpers.py` | `_persist_scan_run()`, `_read_discovery_ranges()`, `_expand_ranges_to_ips()` |
| `scan_engine.py` lines 325-1118 | `scan_engine/executor.py` | `_execute_scan()` (including nested `_ping_host_async`, `_scan_target_async`, `_cred_to_snmp_dict`) |
| `scan_engine.py` lines 1122-1207 | `scan_engine/jobs.py` | `_run_scan_job()`, `_start_job()` |
| `scan_engine.py` lines 1213-1310 | `scan_engine/scheduler.py` | `_scheduler_wake`, `_dispatch_scheduled_scan()`, `_background_scheduler()` |

### Detailed File Specifications

#### 3.0 Rename `backend/scan_engine.py` to `backend/scan_engine_old.py` (temporary backup)

After confirming all modules work, delete `scan_engine_old.py`.

#### 3.1 Create `backend/scan_engine/__init__.py`

This file re-exports the full public API so all existing imports (`from scan_engine import X`) continue to work unchanged.

```python
"""Scan engine package -- re-exports for backward compatibility."""
from scan_engine.broadcast import _broadcast_progress, _broadcast_scan_complete
from scan_engine.event_loop import _get_bg_loop
from scan_engine.ping import _build_ping_cmd, _ping_host
from scan_engine.dns import (
    _DNS_CACHE_MAX, _evict_dns_cache, _resolve_host, _resolve_ip,
)
from scan_engine.db_helpers import (
    _safe_json_list, _canonical_link_key, _persist_scan_run,
    _read_discovery_ranges, _expand_ranges_to_ips,
)
from scan_engine.executor import _execute_scan
from scan_engine.jobs import _run_scan_job, _start_job
from scan_engine.scheduler import (
    _scheduler_wake, _dispatch_scheduled_scan, _background_scheduler,
)

__all__ = [
    "_broadcast_progress", "_broadcast_scan_complete",
    "_get_bg_loop",
    "_build_ping_cmd", "_ping_host",
    "_DNS_CACHE_MAX", "_evict_dns_cache", "_resolve_host", "_resolve_ip",
    "_safe_json_list", "_canonical_link_key", "_persist_scan_run",
    "_read_discovery_ranges", "_expand_ranges_to_ips",
    "_execute_scan",
    "_run_scan_job", "_start_job",
    "_scheduler_wake", "_dispatch_scheduled_scan", "_background_scheduler",
]
```

#### 3.2 Create `backend/scan_engine/broadcast.py`

Contains: `_broadcast_progress()`, `_broadcast_scan_complete()`

```python
"""WebSocket broadcasting for scan progress updates."""
import logging

log = logging.getLogger(__name__)


def _broadcast_progress(scanned: int, total: int, latest_ip: str, success: bool, job_id: str) -> None:
    """Broadcast scan progress to WebSocket clients (fire-and-forget)."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_progress",
            "job_id": job_id,
            "scanned": scanned,
            "total": total,
            "latest_ip": latest_ip,
            "success": success,
        })
    except Exception:
        pass


def _broadcast_scan_complete(job_id: str, status: str, found: int, links: int, duration_ms: int) -> None:
    """Broadcast scan completion to WebSocket clients."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_complete",
            "job_id": job_id,
            "status": status,
            "found": found,
            "links": links,
            "duration_ms": duration_ms,
        })
    except Exception:
        pass
```

Key: The lazy import `from routers.ws import broadcast_scan_update_sync` stays inside the try/except block (preserving the existing circular import avoidance pattern).

#### 3.3 Create `backend/scan_engine/event_loop.py`

Contains: `_bg_loop`, `_bg_loop_lock`, `_get_bg_loop()`

```python
"""Shared background asyncio event loop."""
import asyncio
import threading
from typing import Optional

_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_loop_lock = threading.Lock()


def _get_bg_loop() -> asyncio.AbstractEventLoop:
    """Return the shared background event loop, starting it lazily."""
    global _bg_loop
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_loop_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        loop = asyncio.new_event_loop()

        def _run(l: asyncio.AbstractEventLoop):
            asyncio.set_event_loop(l)
            l.run_forever()

        t = threading.Thread(target=_run, args=(loop,), daemon=True)
        t.start()
        _bg_loop = loop
        return loop
```

No changes from original other than standalone file.

#### 3.4 Create `backend/scan_engine/ping.py`

Contains: `_build_ping_cmd()`, `_ping_host()`

```python
"""Ping utilities for host reachability checks."""
import platform
import re
import subprocess


def _build_ping_cmd(ip: str, timeout_sec: int) -> list:
    if platform.system() == "Windows":
        return ["ping", "-n", "1", "-w", str(int(timeout_sec * 1000)), ip]
    return ["ping", "-c", "1", "-W", str(int(timeout_sec)), ip]


def _ping_host(ip: str, timeout_sec: int = 1) -> tuple[bool, int]:
    """Best-effort ICMP ping via system command. Returns (reachable, rtt_ms)."""
    if not ip:
        return False, 0

    cmds = [_build_ping_cmd(ip, timeout_sec)]

    for cmd in cmds:
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(1, timeout_sec + 1),
            )
        except Exception:
            continue

        out = f"{completed.stdout}\n{completed.stderr}".lower()
        if completed.returncode != 0:
            continue

        patterns = [
            r"time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms",
            r"average\s*=\s*([0-9]+)ms",
            r"durchschnitt\s*=\s*([0-9]+)ms",
        ]
        for pattern in patterns:
            m = re.search(pattern, out)
            if m:
                try:
                    return True, int(float(m.group(1)))
                except ValueError:
                    pass
        return True, 1

    return False, 0
```

No cross-module dependencies. Standalone utility.

#### 3.5 Create `backend/scan_engine/dns.py`

Contains: `_resolve_ip()`, `_DNS_CACHE_MAX`, `_evict_dns_cache()`, `_resolve_host()`

```python
"""DNS resolution and caching utilities."""
import logging
import socket

from shared.state import _log_event

log = logging.getLogger(__name__)

_DNS_CACHE_MAX = 10000


def _evict_dns_cache(cache: dict[str, str]) -> None:
    """Evict oldest half of entries when cache exceeds size limit."""
    if len(cache) < _DNS_CACHE_MAX:
        return
    keys = list(cache.keys())
    for k in keys[:len(keys) // 2]:
        del cache[k]


def _resolve_ip(sys_name: str, switch_data: dict) -> str:
    """Try to find the management IP of a device by sysName in the scan batch."""
    for ip, sw in switch_data.items():
        if sw.sys_name and sys_name.lower() in sw.sys_name.lower():
            return ip
    try:
        return socket.gethostbyname(sys_name)
    except Exception:
        return ""


def _resolve_host(
    ip: str,
    cache: dict[str, str],
    dns_servers: list[str] | None = None,
    correlation_id: str = "",
) -> str:
    """Best-effort reverse DNS lookup with per-scan cache."""
    if not ip:
        return ""
    if ip in cache:
        _log_event(
            logging.INFO,
            "dns.lookup.cache",
            correlation_id=correlation_id,
            ip=ip,
            host=cache[ip],
        )
        return cache[ip]

    if dns_servers:
        try:
            import dns.resolver
            import dns.reversename

            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = dns_servers
            resolver.timeout = 1.5
            resolver.lifetime = 2.5
            query_name = dns.reversename.from_address(ip)
            answers = resolver.resolve(query_name, "PTR")
            host = str(answers[0]).rstrip(".") if answers else ""
            _evict_dns_cache(cache)
            cache[ip] = host
            _log_event(
                logging.INFO,
                "dns.lookup",
                correlation_id=correlation_id,
                ip=ip,
                host=host,
                resolver="custom",
                nameservers=dns_servers,
                success=bool(host),
            )
            return host
        except Exception:
            pass

    try:
        _evict_dns_cache(cache)
        cache[ip] = socket.gethostbyaddr(ip)[0]
        _log_event(
            logging.INFO,
            "dns.lookup",
            correlation_id=correlation_id,
            ip=ip,
            host=cache[ip],
            resolver="system",
            success=bool(cache[ip]),
        )
    except Exception:
        _evict_dns_cache(cache)
        cache[ip] = ""
        _log_event(
            logging.WARNING,
            "dns.lookup",
            correlation_id=correlation_id,
            ip=ip,
            host="",
            resolver="system",
            success=False,
        )
    return cache[ip]
```

Imports: `socket`, `logging`, `shared.state._log_event`; conditional `dns.resolver`, `dns.reversename` (already lazy inside try/except).

#### 3.6 Create `backend/scan_engine/db_helpers.py`

Contains: `_safe_json_list()`, `_canonical_link_key()`, `_persist_scan_run()`, `_read_discovery_ranges()`, `_expand_ranges_to_ips()`

```python
"""Database write utilities for scan results."""
import ipaddress
import json
import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from database import AppSetting, ScanRun, ScanRunSwitchMetric
from schemas import ScanResult

log = logging.getLogger(__name__)


def _safe_json_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return [str(v) for v in value]
    except Exception:
        pass
    return []


def _canonical_link_key(local_ip: str, local_port: str, remote_ip: str, remote_port: str) -> str:
    return f"{local_ip}|{local_port}|{remote_ip}|{remote_port}"


def _persist_scan_run(db: Session, result: ScanResult, devices_snapshot: List[str], links_snapshot: List[str]) -> int:
    run = ScanRun(
        status=result.status,
        scanned=result.scanned,
        found=result.found,
        links=result.links,
        max_workers=result.max_workers,
        total_duration_ms=result.total_duration_ms,
        error_count=len(result.errors or []),
        devices_snapshot_json=json.dumps(sorted(set(devices_snapshot))),
        links_snapshot_json=json.dumps(sorted(set(links_snapshot))),
    )
    db.add(run)
    db.flush()

    for metric in result.switch_metrics:
        db.add(ScanRunSwitchMetric(
            scan_run_id=run.id,
            ip=metric.ip,
            label=metric.label,
            duration_ms=metric.duration_ms,
            success=metric.success,
            error=metric.error,
        ))

    db.commit()
    return run.id


def _read_discovery_ranges(db: Session) -> List[str]:
    """Return list of configured CIDR/IP discovery ranges from AppSettings."""
    row = db.query(AppSetting).filter(AppSetting.key == "discovery_scan_ranges").first()
    if not row or not row.value:
        return []
    try:
        value = json.loads(row.value)
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
    except Exception:
        pass
    return []


def _expand_ranges_to_ips(ranges: List[str]) -> List[str]:
    """Expand a list of CIDR ranges or single IPs into individual IP strings."""
    result: List[str] = []
    for entry in ranges:
        entry = entry.strip()
        if not entry:
            continue
        try:
            network = ipaddress.ip_network(entry, strict=False)
            if network.num_addresses > 65536:
                log.warning("Skipping oversized range %s (%d hosts)", entry, network.num_addresses)
                continue
            result.extend(str(ip) for ip in network.hosts())
        except ValueError:
            try:
                result.append(str(ipaddress.ip_address(entry)))
            except ValueError:
                log.warning("Invalid IP/range in discovery_scan_ranges: %s", entry)
    return result
```

#### 3.7 Create `backend/scan_engine/executor.py`

Contains: `_execute_scan()` -- the entire async coroutine (lines 325-1118)

This is the largest module. Copy the entire `_execute_scan` function as-is. The imports it needs at the top of the file:

```python
"""Core scan execution engine."""
import asyncio
import json
import logging
import re
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database import (
    AppSetting, Credential, Device, Port, SessionLocal, SnmpProfile,
    ScanRun, ScanRunSwitchMetric, SwitchClass, TopologyLink, DryRunResult,
)
from schemas import ScanResult, ScanSwitchMetric
from shared.file_settings import _read_dns_settings, _read_scan_settings
from shared.state import _log_event
from shared.crypto import decrypt
from shared.metrics import SCAN_ACTIVE, SCAN_DURATION, SCAN_TOTAL, DEVICE_COUNT, PORT_COUNT
from snmp_scanner import (
    LldpNeighbor, SwitchData, auto_layout, extract_model,
    is_virtual, scan_switch, speed_label,
)

from scan_engine.broadcast import _broadcast_progress, _broadcast_scan_complete
from scan_engine.ping import _build_ping_cmd
from scan_engine.dns import _resolve_host, _resolve_ip
from scan_engine.db_helpers import (
    _safe_json_list, _canonical_link_key, _persist_scan_run,
    _read_discovery_ranges, _expand_ranges_to_ips,
)

log = logging.getLogger(__name__)
```

The function body is copied verbatim. The lazy import at line 1106 (`from routers.topology import _bump_topo_version`) stays as-is inside the function body.

The nested functions `_ping_host_async()`, `_scan_target_async()`, `_cred_to_snmp_dict()` remain nested inside `_execute_scan()` (they use closure variables like `cancel_event`, `scan_mode`, etc.).

#### 3.8 Create `backend/scan_engine/jobs.py`

Contains: `_run_scan_job()`, `_start_job()`

```python
"""Job management for scan execution."""
import logging
import threading
import uuid
from datetime import datetime, timezone

from database import SessionLocal
from schemas import ScanResult
from shared.state import _log_event, set_scan_job, update_scan_job

from scan_engine.event_loop import _get_bg_loop
from scan_engine.executor import _execute_scan

log = logging.getLogger(__name__)
```

Then copy `_run_scan_job()` and `_start_job()` verbatim. The lazy imports inside `_start_job()` remain:
- `from shared.redis_client import get_redis` (already lazy at line 1173)
- `from tasks import run_scan_task` (already lazy at line 1176)

Note: `import asyncio` also needed at the top since `_run_scan_job` calls `asyncio.run_coroutine_threadsafe`.

#### 3.9 Create `backend/scan_engine/scheduler.py`

Contains: `_scheduler_wake`, `_dispatch_scheduled_scan()`, `_background_scheduler()`

```python
"""Background scan scheduler."""
import logging
import threading
import time
import uuid
from datetime import datetime, timezone

from database import AppSetting, SessionLocal
from shared.state import _log_event, set_scan_job, can_dispatch_scan

from scan_engine.event_loop import _get_bg_loop
from scan_engine.executor import _execute_scan

log = logging.getLogger(__name__)

_scheduler_wake = threading.Event()
```

Then copy `_dispatch_scheduled_scan()` and `_background_scheduler()` verbatim. The lazy imports stay:
- `from shared.redis_client import get_redis` (inside `_dispatch_scheduled_scan`)
- `from tasks import run_scan_task` (inside `_dispatch_scheduled_scan`)
- `from shared.state import acquire_scan_lock, release_scan_lock` (inside `_dispatch_scheduled_scan`)

#### 3.10 Delete `backend/scan_engine.py` (the original file)

After creating all modules and verifying tests pass, delete the original monolithic file.

### External Import Verification

All these files import from `scan_engine` and will continue to work via `__init__.py` re-exports (zero changes needed):

| File | Import Statement | Re-exported From |
|------|-----------------|------------------|
| `main.py` line 19 | `from scan_engine import _background_scheduler` | `scheduler.py` |
| `tasks.py` line 8 | `from scan_engine import _execute_scan` | `executor.py` |
| `routers/scan.py` line 10 | `from scan_engine import _execute_scan, _start_job` | `executor.py`, `jobs.py` |
| `routers/scan_settings.py` line 10 | `from scan_engine import _read_discovery_ranges` | `db_helpers.py` |
| `routers/scan_runs.py` line 8 | `from scan_engine import _safe_json_list` | `db_helpers.py` |
| `routers/ws.py` line 42 | `from scan_engine import _get_bg_loop` | `event_loop.py` |

None of these files need any modification.

### Lazy Import Preservation

These lazy imports inside function bodies must be preserved exactly as-is:

1. **`broadcast.py`**: `from routers.ws import broadcast_scan_update_sync` (inside try/except in both functions)
2. **`executor.py`**: `from routers.topology import _bump_topo_version` (at end of `_execute_scan`, ~original line 1106)
3. **`jobs.py`**: `from shared.redis_client import get_redis` and `from tasks import run_scan_task` (inside `_start_job`)
4. **`scheduler.py`**: `from shared.redis_client import get_redis`, `from tasks import run_scan_task`, `from shared.state import acquire_scan_lock, release_scan_lock` (inside `_dispatch_scheduled_scan`)

### Checklist

- [ ] 3.1 Create `backend/scan_engine/` directory
- [ ] 3.2 Create `backend/scan_engine/__init__.py` with all re-exports
- [ ] 3.3 Create `backend/scan_engine/broadcast.py` (functions: `_broadcast_progress`, `_broadcast_scan_complete`)
- [ ] 3.4 Create `backend/scan_engine/event_loop.py` (functions: `_get_bg_loop`; globals: `_bg_loop`, `_bg_loop_lock`)
- [ ] 3.5 Create `backend/scan_engine/ping.py` (functions: `_build_ping_cmd`, `_ping_host`)
- [ ] 3.6 Create `backend/scan_engine/dns.py` (functions: `_resolve_ip`, `_evict_dns_cache`, `_resolve_host`; constants: `_DNS_CACHE_MAX`)
- [ ] 3.7 Create `backend/scan_engine/db_helpers.py` (functions: `_safe_json_list`, `_canonical_link_key`, `_persist_scan_run`, `_read_discovery_ranges`, `_expand_ranges_to_ips`)
- [ ] 3.8 Create `backend/scan_engine/executor.py` (function: `_execute_scan` with all nested functions intact)
- [ ] 3.9 Create `backend/scan_engine/jobs.py` (functions: `_run_scan_job`, `_start_job`)
- [ ] 3.10 Create `backend/scan_engine/scheduler.py` (functions: `_dispatch_scheduled_scan`, `_background_scheduler`; global: `_scheduler_wake`)
- [ ] 3.11 Delete `backend/scan_engine.py` (the original monolithic file)
- [ ] 3.12 Run all tests: `python -m pytest tests/ -v`
- [ ] 3.13 Verify imports work: `python -c "from scan_engine import _execute_scan, _start_job, _background_scheduler, _safe_json_list, _read_discovery_ranges, _get_bg_loop, _scheduler_wake; print('All imports OK')"`
- [ ] 3.14 Verify no `__pycache__` conflicts: delete `backend/__pycache__/scan_engine.*` if present

---

## Step 4: Celery Beat Scheduler Migration (AD-2)

**Goal:** Replace the thread-based `_background_scheduler` with a Celery Beat periodic task, keeping the thread fallback for development without Celery.

**Dependencies:** Step 3 (CQ-2) MUST be completed first. The scheduler lives in `scan_engine/scheduler.py` after modularization.
**Breaking changes:** Requires running `celery beat` as a separate process in Docker.

### Files to Modify

#### 4.1 `backend/tasks.py` -- Add `scheduler_tick` task

Add a new Celery task that replicates the body of `_background_scheduler`'s loop (reading settings, checking intervals, dispatching scans):

```python
# Add these imports at top:
import time
from database import AppSetting

# Module-level tracking for last dispatch times (per-worker persistent)
_last_dispatch = {"discovery": 0, "links": 0, "macs": 0}

@celery_app.task
def scheduler_tick():
    """Periodic scheduler tick -- replaces _background_scheduler loop body.

    Reads scan intervals from DB settings and dispatches scans
    when their interval has elapsed.
    """
    from scan_engine.scheduler import _dispatch_scheduled_scan

    db = SessionLocal()
    try:
        discovery_setting = db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
        links_setting = db.query(AppSetting).filter(AppSetting.key == "link_update_interval_sec").first()
        macs_setting = db.query(AppSetting).filter(AppSetting.key == "mac_update_interval_sec").first()
        ports_legacy_setting = db.query(AppSetting).filter(AppSetting.key == "port_update_interval_sec").first()

        discovery_interval = int(discovery_setting.value) if discovery_setting else 1800
        legacy_ports_interval = int(ports_legacy_setting.value) if ports_legacy_setting else 30
        links_interval = int(links_setting.value) if links_setting else legacy_ports_interval
        macs_interval = int(macs_setting.value) if macs_setting else legacy_ports_interval
    finally:
        db.close()

    now = time.time()

    if macs_interval > 0 and (now - _last_dispatch["macs"]) >= macs_interval:
        _log_event(logging.INFO, "scheduler.macs.start")
        _dispatch_scheduled_scan("macs")
        _last_dispatch["macs"] = time.time()

    if links_interval > 0 and (now - _last_dispatch["links"]) >= links_interval:
        _log_event(logging.INFO, "scheduler.links.start")
        _dispatch_scheduled_scan("links")
        _last_dispatch["links"] = time.time()

    if discovery_interval > 0 and (now - _last_dispatch["discovery"]) >= discovery_interval:
        _log_event(logging.INFO, "scheduler.discovery.start")
        _dispatch_scheduled_scan("discovery")
        _last_dispatch["discovery"] = time.time()
```

Note: `_dispatch_scheduled_scan` is imported lazily to avoid circular import with `scan_engine.scheduler` importing from `tasks`.

#### 4.2 `backend/celery_app.py` -- Add Beat schedule

Add beat schedule configuration after the existing `celery_app.conf.update(...)`:

```python
celery_app.conf.beat_schedule = {
    "scheduler-tick": {
        "task": "tasks.scheduler_tick",
        "schedule": 5.0,
    },
}
```

This makes Celery Beat call `scheduler_tick` every 5 seconds, matching the current `_scheduler_wake.wait(timeout=5)` behavior.

#### 4.3 `backend/main.py` -- Conditional scheduler thread

Change the scheduler startup from unconditional to only when Celery Beat is not running:

```python
# In the lifespan function, change:
#     threading.Thread(target=_background_scheduler, daemon=True).start()
# To:
    from shared.redis_client import get_redis
    if not get_redis():
        # No Redis = no Celery Beat; use thread-based scheduler fallback
        threading.Thread(target=_background_scheduler, daemon=True).start()
    else:
        _log.info("Celery Beat scheduler detected (Redis available); skipping thread-based scheduler")
```

This keeps the thread fallback for development (no Redis) but avoids duplicate scheduling when Celery Beat is running.

#### 4.4 `docker-compose.yml` -- Add Celery Beat service

Add a new service after the `celery-worker` service:

```yaml
  # ─── Celery Beat Scheduler ───────────────────────────────────────────────────
  celery-beat:
    build: ./backend
    container_name: netmap-celery-beat
    restart: unless-stopped
    command: celery -A celery_app beat --loglevel=info
    environment:
      DATABASE_URL: "postgresql://netmap:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@postgres/netmap"
      REDIS_URL: "redis://redis:6379/0"
      SECRET_TOKEN: "${SECRET_TOKEN:?Set SECRET_TOKEN in .env}"
      JWT_SECRET: "${JWT_SECRET:-}"
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:-}"
    networks:
      - netmap
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.25"
    logging: *default-logging
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
```

Note: No volumes needed (beat only reads settings from DB and dispatches tasks). Low resource limits since it's a lightweight process.

### Checklist

- [ ] 4.1 Add `scheduler_tick` task to `backend/tasks.py`
- [ ] 4.2 Add `beat_schedule` config to `backend/celery_app.py`
- [ ] 4.3 Make scheduler thread conditional on Redis availability in `backend/main.py`
- [ ] 4.4 Add `celery-beat` service to `docker-compose.yml`
- [ ] 4.5 Run existing tests: `python -m pytest tests/ -v`
- [ ] 4.6 Test without Redis: verify thread-based scheduler still starts
- [ ] 4.7 Test with Redis: verify `scheduler_tick` task is registered (`celery -A celery_app inspect registered`)

---

## Step 5: Frontend Design Tokens

**Goal:** Create a centralized design tokens file and shared style objects to replace hardcoded hex values across 20+ components. Start incremental adoption.

**Dependencies:** None
**Breaking changes:** None

### Files to Create

#### 5.1 Create `frontend/src/styles/tokens.js`

```js
/**
 * Design tokens -- single source of truth for colors, spacing, radii, and typography.
 *
 * These values match the implicit design system already used across all components.
 * Import from here instead of hardcoding hex values.
 */
export const colors = {
  bg: {
    base: "#020817",
    panel: "#0a0e18",
    card: "#0f172a",
    surface: "#1e293b",
    hover: "#334155",
  },
  text: {
    primary: "#e2e8f0",
    secondary: "#94a3b8",
    muted: "#64748b",
    dark: "#475569",
  },
  accent: {
    cyan: "#22d3ee",
    blue: "#38bdf8",
    purple: "#a78bfa",
    green: "#22c55e",
    yellow: "#fbbf24",
    orange: "#fb923c",
    red: "#f87171",
    pink: "#f472b6",
  },
  status: {
    online: "#22c55e",
    offline: "#f87171",
    warning: "#fbbf24",
  },
  border: {
    default: "#1e293b",
    hover: "#334155",
    focus: "#22d3ee",
  },
};

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  xxl: 12,
};

export const spacing = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
};

export const fonts = {
  base: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', monospace",
};

export const shadows = {
  card: "0 2px 8px rgba(0,0,0,0.3)",
  modal: "0 8px 32px rgba(0,0,0,0.5)",
};
```

#### 5.2 Create `frontend/src/styles/shared.js`

```js
/**
 * Shared style objects for common UI patterns.
 *
 * These replace duplicated inline style objects found across multiple components.
 */
import { colors, radii, fonts, spacing } from "./tokens.js";

export const cardStyle = {
  backgroundColor: colors.bg.card,
  border: `1px solid ${colors.border.default}`,
  borderRadius: radii.xl,
};

export const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  background: colors.bg.base,
  color: colors.text.primary,
  border: `1px solid ${colors.border.default}`,
  borderRadius: radii.md,
  fontSize: 14,
  fontFamily: fonts.base,
  outline: "none",
};

export const selectStyle = {
  ...inputStyle,
  cursor: "pointer",
};

export const labelStyle = {
  color: colors.text.secondary,
  fontSize: 13,
  marginBottom: spacing.xs,
  display: "block",
};

export const buttonBase = {
  padding: "7px 18px",
  borderRadius: radii.md,
  border: "none",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: fonts.base,
};

export const primaryButton = {
  ...buttonBase,
  background: colors.accent.cyan,
  color: colors.bg.base,
};

export const dangerButton = {
  ...buttonBase,
  background: colors.accent.red,
  color: "#fff",
};

export const secondaryButton = {
  ...buttonBase,
  background: colors.bg.surface,
  color: colors.text.primary,
  border: `1px solid ${colors.border.default}`,
};

export const tableHeaderStyle = {
  textAlign: "left",
  padding: "8px 12px",
  color: colors.text.secondary,
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: `1px solid ${colors.border.default}`,
};

export const tableCellStyle = {
  padding: "8px 12px",
  color: colors.text.primary,
  borderBottom: `1px solid ${colors.border.default}`,
};
```

### Checklist

- [ ] 5.1 Create `frontend/src/styles/` directory
- [ ] 5.2 Create `frontend/src/styles/tokens.js` with color, radius, spacing, font, shadow tokens
- [ ] 5.3 Create `frontend/src/styles/shared.js` with common card, input, button, table styles
- [ ] 5.4 Run frontend tests: `npm test` (verify no regressions)
- [ ] 5.5 (Future, not part of this plan) Migrate components one at a time to use tokens

---

## Step 6: TypeScript Setup

**Goal:** Add TypeScript infrastructure and convert `api.js` to `api.ts` as the first typed file. Existing `.jsx` files remain untouched.

**Dependencies:** None (can be done in parallel with Step 5)
**Breaking changes:** None (`allowJs: true` means existing JS files continue to work)

### Files to Create/Modify

#### 6.1 Install TypeScript dependencies

```bash
cd frontend
npm install --save-dev typescript @types/react @types/react-dom
```

#### 6.2 Create `frontend/tsconfig.json`

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
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

Key settings:
- `allowJs: true` + `checkJs: false`: existing `.jsx` files are passed through without type errors
- `noEmit: true`: Vite handles transpilation, TypeScript only type-checks
- `moduleResolution: "bundler"`: matches Vite's resolution strategy
- `strict: true`: enforce strict typing on new `.ts` / `.tsx` files

#### 6.3 Rename `frontend/src/api.js` to `frontend/src/api.ts`

Add type annotations to the file. The key type additions:

At the top of the file, add interface definitions:
```typescript
interface ApiResponse {
  get: (path: string) => Promise<any>;
  post: <T = any>(path: string, body?: unknown) => Promise<T>;
  put: <T = any>(path: string, body?: unknown) => Promise<T>;
  patch: <T = any>(path: string, body?: unknown) => Promise<T>;
  del: (path: string) => Promise<void>;
  invalidate: (...paths: string[]) => void;
}

interface ETagCacheEntry {
  etag: string;
  data: unknown;
}
```

Type annotations to add to existing functions:
- `_getAuthHeader(): Record<string, string>`
- `login(token: string, user: { username: string; role: string }): void`
- `logout(): void`
- `getStoredUser(): { username: string; role: string } | null`
- `getStoredToken(): string`
- `getTokenExpiry(): Date | null`
- `isTokenExpiringSoon(thresholdMinutes?: number): boolean`
- `extractErrorMessage(ex: unknown): string`
- `refreshTokenIfNeeded(): Promise<void>`
- `speedLabel(mbps: number): string`
- `speedColor(mbps: number): string`
- `normPort(s: string): string`
- `buildPortLinkMap(links: Array<{local_ip: string; local_port: string; remote_ip: string; remote_port: string}>): Record<string, {link: any; role: string}>`
- `_etagCache: Record<string, ETagCacheEntry>`
- `api: ApiResponse`

#### 6.4 Update all imports of `api.js` to `api.ts`

Since Vite resolves imports without extensions, most imports use `./api.js` or `./api`. These need to be checked. Vite will resolve `./api` to `./api.ts` automatically.

Files that import from `api.js`:
- `frontend/src/store.js` line 2: `import { api, API, _getAuthHeader } from "./api.js";`
- All component files that import from `"../../api.js"` or similar relative paths

The `.js` extension in import paths must be updated to either:
- Remove the extension: `from "./api"` (Vite resolves this)
- Change to `.ts`: `from "./api.ts"` (not recommended -- breaks if file is renamed back)

**Recommended approach:** Leave `.js` extensions in import paths unchanged. Vite's module resolution with `moduleResolution: "bundler"` in tsconfig handles this correctly -- when `api.js` no longer exists but `api.ts` does, Vite resolves it. However, `tsc --noEmit` may complain. To handle this cleanly:

Update `frontend/src/store.js` line 2:
```javascript
import { api, API, _getAuthHeader } from "./api";
```

And update all other files that reference `"../../api.js"` or `"../api.js"` to drop the `.js` extension. These files include (search for `from.*api.js`):
- Grep the codebase for all `import.*from.*api.js` to find the full list.

Alternatively: Keep `.js` extensions and add `"allowImportingTsExtensions": true` to tsconfig, but this is less standard.

**Simplest approach:** Just keep the `.js` extensions everywhere. Vite resolves `./api.js` to `./api.ts` automatically via its resolver. Only `tsc --noEmit` needs configuration -- add `"allowImportingTsExtensions": true` to tsconfig if this causes errors, or simply ignore for now since `checkJs: false` means JS files aren't checked.

#### 6.5 Add typecheck script to `frontend/package.json`

Add to `"scripts"`:
```json
"typecheck": "tsc --noEmit"
```

#### 6.6 Update `frontend/src/__tests__/api.test.js`

Update the import path from:
```javascript
import { ... } from "../api.js";
```
To:
```javascript
import { ... } from "../api";
```

This ensures the test file resolves to the renamed `.ts` file.

### Checklist

- [ ] 6.1 Install TypeScript dependencies: `npm install --save-dev typescript @types/react @types/react-dom`
- [ ] 6.2 Create `frontend/tsconfig.json`
- [ ] 6.3 Rename `frontend/src/api.js` to `frontend/src/api.ts` and add type annotations
- [ ] 6.4 Update import paths in `store.js` and `__tests__/api.test.js` (drop `.js` extension)
- [ ] 6.5 Add `"typecheck": "tsc --noEmit"` script to `package.json`
- [ ] 6.6 Run `npm run typecheck` to verify no type errors in `api.ts`
- [ ] 6.7 Run `npm test` to verify existing tests still pass
- [ ] 6.8 Run `npm run build` to verify Vite builds successfully

---

## Dependencies Between Steps

```
Step 1 (CQ-8: Scanner Discovery) ──── No dependencies
                                         |
Step 2 (PC-2: Query Optimization) ──── No dependencies
                                         |
Step 3 (CQ-2: Scan Engine Split) ──── No functional dependency (do after 1-2 to avoid merge conflicts)
                                         |
Step 4 (AD-2: Celery Beat) ──────────── DEPENDS ON Step 3 (scheduler in scan_engine/scheduler.py)
                                         |
Step 5 (CSS Tokens) ─────────────────── No dependencies
                                         |
Step 6 (TypeScript) ─────────────────── No dependencies
```

- Steps 1 and 2 are fully independent and could be done in parallel.
- Step 3 should come after 1-2 to avoid merge conflicts.
- Step 4 REQUIRES Step 3 (references `scan_engine/scheduler.py`).
- Steps 5 and 6 are independent of each other and of all backend steps.

---

## Breaking Changes Summary

| Step | Breaking Changes |
|------|-----------------|
| Step 1 (CQ-8) | None |
| Step 2 (PC-2) | None |
| Step 3 (CQ-2) | None (re-exports preserve all existing import paths) |
| Step 4 (AD-2) | Operational: requires running `celery beat` process in Docker. Non-breaking: thread fallback remains for local dev. |
| Step 5 (CSS) | None |
| Step 6 (TS) | None |

---

## VERSION.md Update

After all 6 steps are completed, add a version entry:

```markdown
## v1.14.0 -- Architecture & Infrastructure

**Type:** MINOR (internal restructuring, no user-facing API changes)

### Changes

#### Backend Architecture
- Scanner plugin auto-discovery via `__init_subclass__` (CQ-8)
- Topology query optimization: credential IP subquery (PC-2)
- Scan engine modularized into 8-module package (CQ-2): broadcast, event_loop, ping, dns, db_helpers, executor, jobs, scheduler
- Celery Beat scheduler migration with thread-based fallback (AD-2)

#### Frontend Architecture
- Design tokens file (`styles/tokens.js`) and shared style objects (`styles/shared.js`)
- TypeScript infrastructure: `tsconfig.json`, `api.ts` typed API layer

### Breaking Changes
- Docker: new `celery-beat` service required in `docker-compose.yml`
```
