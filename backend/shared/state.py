"""Shared state: log buffer and scan job registry.

Uses Redis when REDIS_URL is configured; falls back to in-process memory.
"""
import json
import logging
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Dict, Optional

from shared import redis_client
from shared.redis_client import get_redis

# ── In-memory fallbacks (used when Redis is unavailable) ─────────────────────

LOG_BUFFER: deque = deque(maxlen=5000)
LOG_BUFFER_LOCK: threading.Lock = threading.Lock()

SCAN_JOBS: Dict[str, dict] = {}
SCAN_JOBS_LOCK: threading.Lock = threading.Lock()

# Local storage for non-serializable job metadata (cancel_event, thread).
# These objects cannot be stored in Redis and are only relevant within
# the current process.
_LOCAL_JOB_META: Dict[str, dict] = {}

log = logging.getLogger(__name__)


# ── Logging ──────────────────────────────────────────────────────────────────


def _log_event(level: int, event: str, **fields) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": logging.getLevelName(level),
        "event": event,
        **fields,
    }
    line = json.dumps(payload, ensure_ascii=False, default=str)

    r = get_redis()
    if r:
        try:
            r.lpush("netmap:logs", json.dumps(payload, default=str))
            r.ltrim("netmap:logs", 0, 4999)
        except Exception:
            with LOG_BUFFER_LOCK:
                LOG_BUFFER.append(payload)
    else:
        with LOG_BUFFER_LOCK:
            LOG_BUFFER.append(payload)

    log.log(level, line)


def get_log_entries(
    limit: int = 200,
    level: str = "",
    event_prefix: str = "",
    query: str = "",
) -> list:
    """Return recent structured backend logs, optionally filtered."""
    clamped = max(1, min(2000, limit))
    level_filter = level.strip().upper()
    event_filter = event_prefix.strip()
    q = query.strip().lower()

    redis_client = get_redis()
    if redis_client:
        try:
            # The list is newest-first (lpush); normalize to chronological
            # order so filtering and tail-selection match the memory path.
            raw = redis_client.lrange("netmap:logs", 0, 4999)
            rows = [json.loads(x) for x in reversed(raw)]
        except Exception:
            with LOG_BUFFER_LOCK:
                rows = list(LOG_BUFFER)
    else:
        with LOG_BUFFER_LOCK:
            rows = list(LOG_BUFFER)

    if level_filter:
        rows = [row for row in rows if str(row.get("level", "")).upper() == level_filter]
    if event_filter:
        rows = [row for row in rows if str(row.get("event", "")).startswith(event_filter)]
    if q:
        rows = [
            row for row in rows
            if q in json.dumps(row, ensure_ascii=False).lower()
        ]
    return rows[-clamped:]


# ── Scan Jobs ────────────────────────────────────────────────────────────────


def set_scan_job(job_id: str, data: dict) -> None:
    """Store scan job state. Non-serializable fields (cancel_event, thread) are
    kept in local process memory only."""
    r = get_redis()
    if r:
        try:
            serializable = {
                k: v for k, v in data.items()
                if k not in ("cancel_event", "thread")
            }
            r.hset("netmap:scan_jobs", job_id, json.dumps(serializable, default=str))
            r.expire("netmap:scan_jobs", 86400)
            local = {k: v for k, v in data.items() if k in ("cancel_event", "thread")}
            if local:
                _LOCAL_JOB_META[job_id] = local
            return
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        SCAN_JOBS[job_id] = data


def get_scan_job(job_id: str) -> Optional[dict]:
    """Get scan job state dict, merging Redis data with local metadata."""
    r = get_redis()
    if r:
        try:
            raw = r.hget("netmap:scan_jobs", job_id)
            if not raw:
                return None
            data = json.loads(raw)
            local = _LOCAL_JOB_META.get(job_id, {})
            data.update(local)
            return data
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        return SCAN_JOBS.get(job_id)


def update_scan_job(job_id: str, updates: dict) -> None:
    """Merge updates into existing scan job state."""
    r = get_redis()
    if r:
        try:
            raw = r.hget("netmap:scan_jobs", job_id)
            if not raw:
                return
            data = json.loads(raw)
            serializable = {
                k: v for k, v in updates.items()
                if k not in ("cancel_event", "thread")
            }
            data.update(serializable)
            r.hset("netmap:scan_jobs", job_id, json.dumps(data, default=str))
            local_updates = {k: v for k, v in updates.items() if k in ("cancel_event", "thread")}
            if local_updates:
                meta = _LOCAL_JOB_META.setdefault(job_id, {})
                meta.update(local_updates)
            return
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if state:
            state.update(updates)


def delete_scan_job(job_id: str) -> None:
    """Remove a scan job from all stores."""
    r = get_redis()
    if r:
        try:
            r.hdel("netmap:scan_jobs", job_id)
        except Exception:
            pass
    _LOCAL_JOB_META.pop(job_id, None)
    with SCAN_JOBS_LOCK:
        SCAN_JOBS.pop(job_id, None)


def list_scan_jobs() -> Dict[str, dict]:
    """Return all scan jobs as {job_id: state_dict}."""
    r = get_redis()
    if r:
        try:
            all_raw = r.hgetall("netmap:scan_jobs")
            result = {}
            for k, v in all_raw.items():
                job_id = k if isinstance(k, str) else k.decode()
                data = json.loads(v)
                local = _LOCAL_JOB_META.get(job_id, {})
                data.update(local)
                result[job_id] = data
            return result
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        return dict(SCAN_JOBS)


def request_scan_cancel(job_id: str) -> bool:
    """Signal cancellation for a scan job. Returns True if the job was found."""
    found = False
    r = get_redis()
    if r:
        try:
            raw = r.hget("netmap:scan_jobs", job_id)
            if raw:
                data = json.loads(raw)
                data["cancel_requested"] = True
                r.hset("netmap:scan_jobs", job_id, json.dumps(data, default=str))
                found = True
        except Exception:
            pass
    # Also set local cancel_event if present (for thread-based jobs)
    local = _LOCAL_JOB_META.get(job_id, {})
    cancel_event = local.get("cancel_event")
    if cancel_event:
        cancel_event.set()
        found = True
    # Check in-memory fallback
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if state:
            state["cancel_requested"] = True
            ce = state.get("cancel_event")
            if ce:
                ce.set()
            found = True
    return found


def is_cancel_requested(job_id: str) -> bool:
    """Check if cancellation was requested for a job."""
    # Check local event first (for thread-based jobs in this process)
    local = _LOCAL_JOB_META.get(job_id, {})
    ce = local.get("cancel_event")
    if ce and ce.is_set():
        return True
    # Check Redis
    r = get_redis()
    if r:
        try:
            raw = r.hget("netmap:scan_jobs", job_id)
            if raw:
                data = json.loads(raw)
                return data.get("cancel_requested", False)
        except Exception:
            pass
    # Check in-memory fallback
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if state:
            return state.get("cancel_requested", False)
    return False


# ── Scan Lock (distributed priority-based mutual exclusion) ──────────────────

SCAN_PRIORITY = {
    "macs": 3,
    "full": 3,
    "ports": 3,
    "links": 2,
    "discovery": 1,
}

_SCAN_LOCK_TTL = 600  # seconds -- safety TTL for crash recovery; renewed during scans

# In-memory fallback when Redis is unavailable
_LOCAL_SCAN_LOCK = threading.Lock()
_LOCAL_ACTIVE_SCAN: Optional[str] = None
_LOCAL_LOCK_TOKEN: Optional[str] = None

# Compare-and-delete release: only removes the lock when the caller still owns
# it. Never deletes anything on error.
_RELEASE_LOCK_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("del", KEYS[1])
    redis.call("del", KEYS[2])
    return 1
end
return 0
"""

# Compare-and-renew: extends the TTL only when the caller still owns the lock.
_RENEW_LOCK_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("expire", KEYS[1], ARGV[2])
    redis.call("expire", KEYS[2], ARGV[2])
    return 1
end
return 0
"""


def acquire_scan_lock(scan_type: str, timeout: int = 300) -> Optional[str]:
    """Acquire the distributed scan lock for the given scan type.

    Blocks up to *timeout* seconds waiting for the lock.  Returns an opaque
    owner token on success, ``None`` on timeout or when a higher-priority scan
    is waiting.  The token must be passed to :func:`release_scan_lock` and
    :func:`renew_scan_lock`; ownership is enforced by compare-and-delete so a
    stale caller can never release a lock owned by someone else.

    Redis keys used:
      - ``scan:lock``          -- simple mutex (SET NX, TTL), value = owner token
      - ``scan:active_type``   -- which scan type currently holds the lock
      - ``scan:waiting``       -- sorted set of waiting scan types (score = priority)
    """
    global _LOCAL_ACTIVE_SCAN, _LOCAL_LOCK_TOKEN
    priority = SCAN_PRIORITY.get(scan_type, 1)
    token = uuid.uuid4().hex

    r = get_redis()
    if not r:
        if redis_client.REDIS_URL:
            # A process-local fallback cannot serialize distributed workers.
            return None
        # Redis is deliberately disabled: single-process locking only.
        acquired = _LOCAL_SCAN_LOCK.acquire(timeout=timeout)
        if acquired:
            _LOCAL_ACTIVE_SCAN = scan_type
            _LOCAL_LOCK_TOKEN = token
            return token
        return None

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
                    return None

            # Try to acquire the mutex
            acquired = r.set("scan:lock", token, nx=True, ex=_SCAN_LOCK_TTL)
            if acquired:
                r.set("scan:active_type", scan_type, ex=_SCAN_LOCK_TTL)
                r.zrem("scan:waiting", scan_type)
                return token

        except Exception:
            pass

        time.sleep(2)

    # Timed out -- remove ourselves from waiting set
    try:
        r.zrem("scan:waiting", scan_type)
    except Exception:
        pass
    return None


def release_scan_lock(token: str, scan_type: str = "") -> None:
    """Release the distributed scan lock if (and only if) we still own it.

    Ownership is verified by comparing the stored owner token, so a caller
    whose lock already expired (TTL) cannot delete a lock that was re-acquired
    by someone else.  On Redis errors nothing is deleted -- the TTL handles
    crash recovery.
    """
    global _LOCAL_ACTIVE_SCAN, _LOCAL_LOCK_TOKEN

    r = get_redis()
    if not r:
        if redis_client.REDIS_URL:
            return
        if _LOCAL_LOCK_TOKEN == token:
            _LOCAL_ACTIVE_SCAN = None
            _LOCAL_LOCK_TOKEN = None
            try:
                _LOCAL_SCAN_LOCK.release()
            except RuntimeError:
                pass
        return

    try:
        r.eval(_RELEASE_LOCK_LUA, 2, "scan:lock", "scan:active_type", token)
        # Clean up waiting set just in case (keyed by scan type, harmless)
        if scan_type:
            r.zrem("scan:waiting", scan_type)
    except Exception:
        # Best-effort: never delete anything on error
        pass


def renew_scan_lock(token: str, ttl: int = _SCAN_LOCK_TTL) -> bool:
    """Extend the lock TTL if we still own it. Returns True when renewed.

    Long-running scans must call this periodically (the TTL is a crash-recovery
    safety net and can be shorter than the scan duration).
    """
    r = get_redis()
    if not r:
        if redis_client.REDIS_URL:
            return False
        # In-memory fallback has no TTL -- nothing to renew
        return _LOCAL_LOCK_TOKEN == token
    try:
        return bool(r.eval(_RENEW_LOCK_LUA, 2, "scan:lock", "scan:active_type", token, ttl))
    except Exception:
        return False


def get_active_scan_type() -> Optional[str]:
    """Return the scan type currently holding the lock, or None."""
    r = get_redis()
    if r:
        try:
            return r.get("scan:active_type")
        except Exception:
            pass
    return _LOCAL_ACTIVE_SCAN


def can_dispatch_scan(scan_type: str) -> bool:
    """Check whether a scan of the given type should be dispatched.

    Returns False if:
      - A scan of equal or higher priority is already running, OR
      - A scan of higher priority is waiting in the queue.
    """
    priority = SCAN_PRIORITY.get(scan_type, 1)

    r = get_redis()
    if not r:
        if redis_client.REDIS_URL:
            return False
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
        return False

    return True
