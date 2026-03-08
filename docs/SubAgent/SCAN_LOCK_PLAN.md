# Scan Lock Implementation Plan

## Overview

Introduce a Redis-based distributed scan lock with priority ordering so that concurrent scan types (discovery, links, macs) do not overlap. Also increase Celery concurrency from 2 to 4.

**Priority order:** MACs (3) > Links (2) > Discovery (1)

**Behavior:**
- Only one scan runs at a time (mutual exclusion)
- When a higher-priority scan wants to run, it waits for the current scan to finish, then runs before any lower-priority scans
- Lower-priority scans are skipped/deferred if a higher-priority scan is waiting or running
- Manual/full scans get the highest priority (same as MACs)

---

## Checklist

- [ ] Step 1: Increase Celery concurrency in docker-compose.yml
- [ ] Step 2: Add scan lock functions to backend/shared/state.py
- [ ] Step 3: Modify backend/tasks.py to acquire/release scan lock around execution
- [ ] Step 4: Modify backend/scan_engine.py scheduler to respect lock priority
- [ ] Step 5: Test the changes

---

## Step 1: Increase Celery Concurrency

**File:** `docker-compose.yml`
**Line:** 86

**Find:**
```yaml
    command: celery -A celery_app worker --loglevel=info --concurrency=2
```

**Replace with:**
```yaml
    command: celery -A celery_app worker --loglevel=info --concurrency=4
```

---

## Step 2: Add Scan Lock Functions to backend/shared/state.py

**File:** `backend/shared/state.py`

Add the following at the **end of the file** (after the `is_cancel_requested` function, after line 255):

### 2a. Priority constants and in-memory fallback lock

```python
# ── Scan Lock (distributed priority-based mutual exclusion) ──────────────────

SCAN_PRIORITY = {
    "macs": 3,
    "full": 3,
    "ports": 3,
    "links": 2,
    "discovery": 1,
}

_SCAN_LOCK_TTL = 600  # seconds -- safety TTL for crash recovery

# In-memory fallback when Redis is unavailable
_LOCAL_SCAN_LOCK = threading.Lock()
_LOCAL_ACTIVE_SCAN: Optional[str] = None
```

### 2b. acquire_scan_lock function

```python
def acquire_scan_lock(scan_type: str, timeout: int = 300) -> bool:
    """Acquire the distributed scan lock for the given scan type.

    Blocks up to *timeout* seconds waiting for the lock.  Returns True if
    acquired, False if timed out or a higher/equal-priority scan is already
    waiting.

    Redis keys used:
      - ``scan:lock``          -- simple mutex (SET NX, TTL)
      - ``scan:active_type``   -- which scan type currently holds the lock
      - ``scan:waiting``       -- sorted set of waiting scan types (score = priority)
    """
    global _LOCAL_ACTIVE_SCAN
    priority = SCAN_PRIORITY.get(scan_type, 1)

    r = get_redis()
    if not r:
        # In-memory fallback -- simple blocking lock, no priority logic
        acquired = _LOCAL_SCAN_LOCK.acquire(timeout=timeout)
        if acquired:
            _LOCAL_ACTIVE_SCAN = scan_type
        return acquired

    # Register ourselves as waiting so lower-priority dispatches can see us
    try:
        r.zadd("scan:waiting", {scan_type: priority})
    except Exception:
        pass

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            # Check if a higher-priority scan is waiting (we should yield)
            waiting = r.zrevrange("scan:waiting", 0, 0, withscores=True)
            if waiting:
                top_type, top_prio = waiting[0]
                if isinstance(top_type, bytes):
                    top_type = top_type.decode()
                if int(top_prio) > priority:
                    # A higher-priority scan is waiting -- give up
                    r.zrem("scan:waiting", scan_type)
                    return False

            # Try to acquire the mutex
            acquired = r.set("scan:lock", scan_type, nx=True, ex=_SCAN_LOCK_TTL)
            if acquired:
                r.set("scan:active_type", scan_type, ex=_SCAN_LOCK_TTL)
                r.zrem("scan:waiting", scan_type)
                return True

        except Exception:
            pass

        time.sleep(2)

    # Timed out -- remove ourselves from waiting set
    try:
        r.zrem("scan:waiting", scan_type)
    except Exception:
        pass
    return False
```

### 2c. release_scan_lock function

```python
def release_scan_lock(scan_type: str) -> None:
    """Release the distributed scan lock."""
    global _LOCAL_ACTIVE_SCAN

    r = get_redis()
    if not r:
        _LOCAL_ACTIVE_SCAN = None
        try:
            _LOCAL_SCAN_LOCK.release()
        except RuntimeError:
            pass
        return

    try:
        # Only release if we still own the lock
        current = r.get("scan:lock")
        if current == scan_type:
            r.delete("scan:lock")
            r.delete("scan:active_type")
        # Clean up waiting set just in case
        r.zrem("scan:waiting", scan_type)
    except Exception:
        # Best-effort cleanup
        try:
            r.delete("scan:lock")
            r.delete("scan:active_type")
        except Exception:
            pass
```

### 2d. get_active_scan_type function

```python
def get_active_scan_type() -> Optional[str]:
    """Return the scan type currently holding the lock, or None."""
    r = get_redis()
    if r:
        try:
            return r.get("scan:active_type")
        except Exception:
            pass
    return _LOCAL_ACTIVE_SCAN
```

### 2e. can_dispatch_scan function

```python
def can_dispatch_scan(scan_type: str) -> bool:
    """Check whether a scan of the given type should be dispatched.

    Returns False if:
      - A scan of equal or higher priority is already running, OR
      - A scan of higher priority is waiting in the queue.
    """
    priority = SCAN_PRIORITY.get(scan_type, 1)

    r = get_redis()
    if not r:
        if _LOCAL_ACTIVE_SCAN is not None:
            return False
        return True

    try:
        # Check active scan
        active = r.get("scan:active_type")
        if active:
            active_prio = SCAN_PRIORITY.get(active, 1)
            if active_prio >= priority:
                return False

        # Check waiting scans -- if anything with higher priority is waiting, skip
        waiting = r.zrevrange("scan:waiting", 0, 0, withscores=True)
        if waiting:
            _, top_prio = waiting[0]
            if int(top_prio) > priority:
                return False

    except Exception:
        pass

    return True
```

### 2f. Required import additions

At the top of `backend/shared/state.py`, add `time` to imports (line 3 area):

**Find:**
```python
import json
import logging
import threading
```

**Replace with:**
```python
import json
import logging
import threading
import time
```

Also ensure `Optional` is imported (it already is in the existing `from typing import` line -- verify it includes `Optional`). Current line has `from typing import Dict, List, Optional` -- this is fine, no change needed.

---

## Step 3: Modify backend/tasks.py -- Acquire/Release Lock Around Scan Execution

**File:** `backend/tasks.py`

### 3a. Add imports

**Find (line 12):**
```python
from shared.state import update_scan_job, is_cancel_requested, _log_event
```

**Replace with:**
```python
from shared.state import (
    update_scan_job, is_cancel_requested, _log_event,
    acquire_scan_lock, release_scan_lock,
)
```

### 3b. Wrap _execute_scan call with lock acquire/release

**Find (lines 29-66, the entire `run_scan_task` function body):**
```python
@celery_app.task(bind=True, max_retries=2, default_retry_delay=10)
def run_scan_task(self, job_id: str, dry_run: bool = False, scan_type: str = "full"):
    """Execute a network scan as a Celery task."""
    update_scan_job(job_id, {"status": "running"})

    cancel_event = _RedisCancelEvent(job_id)
    db = SessionLocal()
    result = None
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(
            _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run, scan_type=scan_type)
        )
    except Exception as exc:
        _log_event(logging.ERROR, "celery.task.error", job_id=job_id, error=str(exc))
        result = ScanResult(
            scanned=0, found=0, links=0,
            errors=[str(exc)], max_workers=1,
            total_duration_ms=0, switch_metrics=[], status="failed",
        )
        try:
            self.retry(exc=exc)
        except self.MaxRetriesExceededError:
            pass
    finally:
        db.close()
        loop.close()

    if result is None:
        return

    result_dict = result.model_dump()
    if dry_run:
        result_dict["preview"] = result.__dict__.get("_dry_run_preview", [])

    update_scan_job(job_id, {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "result": result_dict,
        "status": result.status if result.status in {"finished", "cancelled", "dry_run"} else "failed",
    })
```

**Replace with:**
```python
@celery_app.task(bind=True, max_retries=2, default_retry_delay=10)
def run_scan_task(self, job_id: str, dry_run: bool = False, scan_type: str = "full"):
    """Execute a network scan as a Celery task."""
    # Acquire distributed scan lock (wait up to 5 min)
    if not acquire_scan_lock(scan_type, timeout=300):
        _log_event(logging.WARNING, "celery.task.lock_skipped",
                   job_id=job_id, scan_type=scan_type)
        update_scan_job(job_id, {
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "result": {"skipped": True, "reason": "scan_lock_priority"},
            "status": "skipped",
        })
        return

    update_scan_job(job_id, {"status": "running"})

    cancel_event = _RedisCancelEvent(job_id)
    db = SessionLocal()
    result = None
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(
            _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run, scan_type=scan_type)
        )
    except Exception as exc:
        _log_event(logging.ERROR, "celery.task.error", job_id=job_id, error=str(exc))
        result = ScanResult(
            scanned=0, found=0, links=0,
            errors=[str(exc)], max_workers=1,
            total_duration_ms=0, switch_metrics=[], status="failed",
        )
        try:
            self.retry(exc=exc)
        except self.MaxRetriesExceededError:
            pass
    finally:
        release_scan_lock(scan_type)
        db.close()
        loop.close()

    if result is None:
        return

    result_dict = result.model_dump()
    if dry_run:
        result_dict["preview"] = result.__dict__.get("_dry_run_preview", [])

    update_scan_job(job_id, {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "result": result_dict,
        "status": result.status if result.status in {"finished", "cancelled", "dry_run"} else "failed",
    })
```

**Key changes:**
1. Call `acquire_scan_lock(scan_type, timeout=300)` before starting the scan
2. If lock not acquired (timed out or lower priority), mark job as "skipped" and return
3. Call `release_scan_lock(scan_type)` in the `finally` block to guarantee cleanup

---

## Step 4: Modify backend/scan_engine.py Scheduler to Respect Lock Priority

**File:** `backend/scan_engine.py`

### 4a. Add import for can_dispatch_scan

**Find (line 26):**
```python
from shared.state import _log_event, set_scan_job, get_scan_job, update_scan_job
```

**Replace with:**
```python
from shared.state import _log_event, set_scan_job, get_scan_job, update_scan_job, can_dispatch_scan
```

### 4b. Add lock check in _dispatch_scheduled_scan

**Find (lines 1132-1165, the `_dispatch_scheduled_scan` function):**
```python
def _dispatch_scheduled_scan(scan_type: str):
    """Run a scheduled scan, using Celery if available, otherwise directly."""
    from shared.redis_client import get_redis
    if get_redis():
        try:
            from tasks import run_scan_task
            job_id = str(uuid.uuid4())
            set_scan_job(job_id, {
                "id": job_id,
                "status": "queued",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "result": None,
                "cancel_requested": False,
            })
            run_scan_task.delay(job_id, False, scan_type)
            _log_event(logging.INFO, "scheduler.%s.dispatched" % scan_type, backend="celery")
            return
        except Exception as exc:
            _log_event(logging.WARNING, "scheduler.celery_fallback", error=str(exc), scan_type=scan_type)

    # Direct execution fallback
    db = SessionLocal()
    loop = _get_bg_loop()
    try:
        future = asyncio.run_coroutine_threadsafe(
            _execute_scan(db, scan_type=scan_type), loop,
        )
        future.result()
    except Exception as e:
        _log_event(logging.ERROR, "scheduler.%s.error" % scan_type, error=str(e))
    finally:
        db.close()
```

**Replace with:**
```python
def _dispatch_scheduled_scan(scan_type: str):
    """Run a scheduled scan, using Celery if available, otherwise directly.

    Checks the distributed scan lock before dispatching: if a higher-priority
    scan is running or waiting, this scan is skipped.
    """
    if not can_dispatch_scan(scan_type):
        _log_event(logging.INFO, "scheduler.%s.skipped" % scan_type,
                   reason="higher_priority_scan_active_or_waiting")
        return

    from shared.redis_client import get_redis
    if get_redis():
        try:
            from tasks import run_scan_task
            job_id = str(uuid.uuid4())
            set_scan_job(job_id, {
                "id": job_id,
                "status": "queued",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "result": None,
                "cancel_requested": False,
            })
            run_scan_task.delay(job_id, False, scan_type)
            _log_event(logging.INFO, "scheduler.%s.dispatched" % scan_type, backend="celery")
            return
        except Exception as exc:
            _log_event(logging.WARNING, "scheduler.celery_fallback", error=str(exc), scan_type=scan_type)

    # Direct execution fallback (also needs lock)
    from shared.state import acquire_scan_lock, release_scan_lock
    if not acquire_scan_lock(scan_type, timeout=60):
        _log_event(logging.INFO, "scheduler.%s.lock_timeout" % scan_type)
        return

    db = SessionLocal()
    loop = _get_bg_loop()
    try:
        future = asyncio.run_coroutine_threadsafe(
            _execute_scan(db, scan_type=scan_type), loop,
        )
        future.result()
    except Exception as e:
        _log_event(logging.ERROR, "scheduler.%s.error" % scan_type, error=str(e))
    finally:
        release_scan_lock(scan_type)
        db.close()
```

**Key changes:**
1. Check `can_dispatch_scan(scan_type)` at the top -- skip immediately if a higher-priority scan blocks
2. In the direct execution fallback, wrap with `acquire_scan_lock` / `release_scan_lock`
3. The Celery path relies on `run_scan_task` (Step 3) to do the actual lock acquisition in the worker

### 4c. Add priority-aware ordering in _background_scheduler

**Find (lines 1211-1223 approximately, inside `_background_scheduler`):**
```python
            if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
                _log_event(logging.INFO, "scheduler.discovery.start")
                _dispatch_scheduled_scan("discovery")
                last_discovery = time.time()

            if links_interval > 0 and (now - last_links) >= links_interval:
                _log_event(logging.INFO, "scheduler.links.start")
                _dispatch_scheduled_scan("links")
                last_links = time.time()

            if macs_interval > 0 and (now - last_macs) >= macs_interval:
                _log_event(logging.INFO, "scheduler.macs.start")
                _dispatch_scheduled_scan("macs")
                last_macs = time.time()
```

**Replace with (dispatch in priority order: macs first, links second, discovery last):**
```python
            # Dispatch in priority order: macs > links > discovery
            # Higher-priority scans are dispatched first so they register
            # in the waiting set before lower-priority checks run.
            if macs_interval > 0 and (now - last_macs) >= macs_interval:
                _log_event(logging.INFO, "scheduler.macs.start")
                _dispatch_scheduled_scan("macs")
                last_macs = time.time()

            if links_interval > 0 and (now - last_links) >= links_interval:
                _log_event(logging.INFO, "scheduler.links.start")
                _dispatch_scheduled_scan("links")
                last_links = time.time()

            if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
                _log_event(logging.INFO, "scheduler.discovery.start")
                _dispatch_scheduled_scan("discovery")
                last_discovery = time.time()
```

---

## Step 5: Testing

### Manual verification steps:
1. Rebuild containers: `docker compose up --build -d`
2. Verify Celery concurrency is 4: `docker compose exec celery-worker celery -A celery_app inspect stats`
3. Trigger a MACs scan via the API and verify `scan:active_type` is set in Redis: `docker compose exec redis redis-cli GET scan:active_type`
4. While a scan is running, trigger a lower-priority scan and verify it is skipped or waits
5. Verify the lock is released after scan completion: `docker compose exec redis redis-cli GET scan:lock` should return nil
6. Check logs for `scheduler.*.skipped` entries when priority blocking occurs

### Edge cases to verify:
- Lock TTL expiry: if a scan crashes without releasing, the lock expires in 600s
- Redis unavailable: falls back to in-memory threading.Lock (no priority logic, just mutual exclusion)
- Manual full scans get priority 3 (same as macs) -- they will not be blocked by links/discovery

---

## File Change Summary

| File | Change |
|------|--------|
| `docker-compose.yml` (line 86) | `--concurrency=2` to `--concurrency=4` |
| `backend/shared/state.py` (imports + end of file) | Add `import time`; add `SCAN_PRIORITY`, `acquire_scan_lock()`, `release_scan_lock()`, `get_active_scan_type()`, `can_dispatch_scan()` |
| `backend/tasks.py` (imports + `run_scan_task`) | Import lock functions; wrap scan execution with acquire/release lock |
| `backend/scan_engine.py` (import + `_dispatch_scheduled_scan` + `_background_scheduler`) | Import `can_dispatch_scan`; add priority check before dispatch; reorder scheduler dispatch to priority order |

---

## Redis Keys Introduced

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `scan:lock` | String | 600s | Mutex -- value is the scan_type holding the lock |
| `scan:active_type` | String | 600s | Informational -- which scan type is running |
| `scan:waiting` | Sorted Set | None | Tracks waiting scan types with priority scores |
