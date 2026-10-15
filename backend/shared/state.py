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

_KEY_PREFIX = "net2map:"
_LEGACY_KEY_PREFIX = "netmap:"


def migrate_legacy_redis_keys() -> int:
    """Rename keys left over from the NetMap era (``netmap:*`` -> ``net2map:*``).

    Idempotent and safe across concurrent workers: RENAMENX never overwrites a
    key that already exists under the new prefix. Returns the number of keys
    renamed.
    """
    r = get_redis()
    if not r:
        return 0
    renamed = 0
    try:
        for key in list(r.scan_iter(match=_LEGACY_KEY_PREFIX + "*", count=500)):
            name = key.decode() if isinstance(key, bytes) else key
            try:
                if r.renamenx(name, _KEY_PREFIX + name[len(_LEGACY_KEY_PREFIX):]):
                    renamed += 1
            except Exception as exc:
                log.debug("legacy redis key %s not migrated: %s", name, exc)
    except Exception as exc:
        log.warning("legacy redis key migration failed: %s", exc)
    if renamed:
        log.info("Migrated %d legacy Redis keys from %s* to %s*", renamed, _LEGACY_KEY_PREFIX, _KEY_PREFIX)
    return renamed


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
            r.lpush("net2map:logs", json.dumps(payload, default=str))
            r.ltrim("net2map:logs", 0, 4999)
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
            raw = redis_client.lrange("net2map:logs", 0, 4999)
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


_SCAN_JOBS_KEY = "net2map:scan_jobs"
# Sorted set job_id -> creation time; drives per-job expiry of the hash.
_SCAN_JOBS_INDEX_KEY = "net2map:scan_jobs:created"
_SCAN_JOB_TTL = 86400  # seconds a job entry is kept after it was created


def _prune_scan_jobs(r, now: float) -> None:
    """Drop job entries created more than _SCAN_JOB_TTL seconds ago.

    The hash-level EXPIRE alone is refreshed by every new job, so with a
    frequent scheduler it never fires and the hash grows without bound.
    """
    cutoff = now - _SCAN_JOB_TTL
    stale = r.zrangebyscore(_SCAN_JOBS_INDEX_KEY, "-inf", cutoff)
    if stale:
        r.hdel(_SCAN_JOBS_KEY, *stale)
        r.zremrangebyscore(_SCAN_JOBS_INDEX_KEY, "-inf", cutoff)
        for job_id in stale:
            _LOCAL_JOB_META.pop(job_id.decode() if isinstance(job_id, bytes) else job_id, None)


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
            now = time.time()
            r.hset(_SCAN_JOBS_KEY, job_id, json.dumps(serializable, default=str))
            r.zadd(_SCAN_JOBS_INDEX_KEY, {job_id: now})
            # Whole-hash safety net (idle installations); per-job expiry below.
            r.expire(_SCAN_JOBS_KEY, _SCAN_JOB_TTL)
            r.expire(_SCAN_JOBS_INDEX_KEY, _SCAN_JOB_TTL)
            try:
                _prune_scan_jobs(r, now)
            except Exception as exc:
                log.debug("scan job pruning failed: %s", exc)
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
            raw = r.hget("net2map:scan_jobs", job_id)
            if raw:
                data = json.loads(raw)
                local = _LOCAL_JOB_META.get(job_id, {})
                data.update(local)
                return data
            # Miss: the job may have been stored in memory while Redis was
            # unreachable (set_scan_job fallback).
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        return SCAN_JOBS.get(job_id)


# Optimistic-locking retries for read-modify-write updates of a job entry.
_JOB_UPDATE_RETRIES = 10


def _merge_scan_job_atomic(r, job_id: str, mutate) -> bool:
    """Atomically apply ``mutate(data)`` to the JSON blob of a job entry.

    Uses WATCH/MULTI on the jobs hash so concurrent writers (worker progress
    updates, API cancel requests) never overwrite each other's fields.
    ``mutate`` may return False to skip the write (conditional update).
    Returns False when the job does not exist in Redis or the write was
    skipped. Raises when the update keeps conflicting or Redis fails (callers
    fall back like for any Redis error).
    """
    try:
        from redis.exceptions import WatchError
    except ImportError:  # pragma: no cover - redis is a hard dependency when configured
        WatchError = ()
    for _ in range(_JOB_UPDATE_RETRIES):
        with r.pipeline() as pipe:
            try:
                pipe.watch(_SCAN_JOBS_KEY)
                raw = pipe.hget(_SCAN_JOBS_KEY, job_id)
                if not raw:
                    pipe.unwatch()
                    return False
                data = json.loads(raw)
                if mutate(data) is False:
                    pipe.unwatch()
                    return False
                pipe.multi()
                pipe.hset(_SCAN_JOBS_KEY, job_id, json.dumps(data, default=str))
                pipe.execute()
                return True
            except WatchError:
                continue
    raise RuntimeError("scan job %s update kept conflicting" % job_id)


def update_scan_job(job_id: str, updates: dict) -> None:
    """Merge updates into existing scan job state."""
    r = get_redis()
    if r:
        try:
            serializable = {
                k: v for k, v in updates.items()
                if k not in ("cancel_event", "thread")
            }
            if not _merge_scan_job_atomic(r, job_id, lambda data: data.update(serializable)):
                return
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


def update_scan_job_if_status(job_id: str, expected_statuses, updates: dict) -> bool:
    """Atomically merge ``updates`` only while the job status is one of ``expected_statuses``.

    Returns True when the update was applied. Used by the stale job reaper so
    a job that a worker just picked up is never overwritten.
    """
    expected = set(expected_statuses)
    serializable = {k: v for k, v in updates.items() if k not in ("cancel_event", "thread")}

    def _mutate(data):
        if data.get("status") not in expected:
            return False
        data.update(serializable)
        return True

    r = get_redis()
    if r:
        try:
            if _merge_scan_job_atomic(r, job_id, _mutate):
                return True
            # Not in Redis (or status changed): the job may live in memory.
        except Exception:
            pass
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if state and state.get("status") in expected:
            state.update(updates)
            return True
    return False


def delete_scan_job(job_id: str) -> None:
    """Remove a scan job from all stores."""
    r = get_redis()
    if r:
        try:
            r.hdel("net2map:scan_jobs", job_id)
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
            all_raw = r.hgetall("net2map:scan_jobs")
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
            if _merge_scan_job_atomic(r, job_id, lambda data: data.update(cancel_requested=True)):
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
            raw = r.hget("net2map:scan_jobs", job_id)
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
    "ranges": 1,
    "ranges_all": 1,
}

_SCAN_LOCK_TTL = 600  # seconds -- safety TTL for crash recovery; renewed during scans

# Name of the scan lease in the lease_fences table and suffix of the Redis
# fencing counter key (net2map:fence:<name>).
SCAN_LOCK_FENCE_NAME = "scan:lock"
_SCAN_LOCK_FENCE_KEY = "net2map:fence:" + SCAN_LOCK_FENCE_NAME

# Redis keys of the scan lock. They intentionally keep their historic,
# unprefixed names: renaming them would let not-yet-upgraded workers (old
# names) and upgraded workers (new names) hold two different locks during a
# rolling upgrade and run scans concurrently.
_SCAN_LOCK_KEY = "scan:lock"
_SCAN_ACTIVE_TYPE_KEY = "scan:active_type"
_SCAN_WAITING_KEY = "scan:waiting"

# Waiting set entries: member "<scan_type>:<registered unix ts>:<owner id>",
# score = priority (unchanged, so priority comparisons by score keep working
# for workers of the previous release that registered the plain scan type).
# Entries older than _WAITING_STALE_SEC (twice the longest lock wait used by
# the callers) are left-overs of crashed waiters and are pruned on read;
# legacy members without a timestamp are pruned as well because their age is
# unknown and the waiting set is only advisory.
_SCAN_LOCK_MAX_WAIT_SEC = 300
_WAITING_STALE_SEC = 2 * _SCAN_LOCK_MAX_WAIT_SEC

# In-memory fallback when Redis is unavailable
_LOCAL_SCAN_LOCK = threading.Lock()
_LOCAL_ACTIVE_SCAN: Optional[str] = None
_LOCAL_LOCK_TOKEN: Optional[str] = None
_LOCAL_FENCE_LOCK = threading.Lock()
_LOCAL_LAST_FENCE = 0

# Atomic acquisition with fencing token. The lock is only taken when free; on
# success the fencing counter is incremented in the same script so the lease
# and its token always belong together. The counter is floored at the Redis
# server time in microseconds: tokens stay strictly increasing (INCR) and
# remain larger than every previously issued token even when the Redis
# dataset is lost, which would otherwise make the database reject every
# future lease holder. The owner token stored in KEYS[1] is
# "<random owner id>:<fencing token>".
_ACQUIRE_LOCK_LUA = """
if redis.call("exists", KEYS[1]) == 1 then
    return false
end
local now = redis.call("time")
local floor = tonumber(now[1]) * 1000000 + tonumber(now[2])
if redis.call("incr", KEYS[3]) < floor then
    redis.call("set", KEYS[3], string.format("%.0f", floor))
end
-- Read the counter back as a string: Lua numbers are doubles.
local owner = ARGV[1] .. ":" .. redis.call("get", KEYS[3])
redis.call("set", KEYS[1], owner, "EX", ARGV[3])
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3])
return owner
"""

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


def _waiting_member(scan_type: str, owner_id: str, now: float) -> str:
    return "%s:%.3f:%s" % (scan_type, now, owner_id)


def _parse_waiting_member(member) -> tuple:
    """Return ``(scan_type, registered_ts or None)`` of a waiting set member."""
    if isinstance(member, bytes):
        member = member.decode()
    parts = str(member).split(":")
    if len(parts) >= 3:
        try:
            return parts[0], float(parts[1])
        except ValueError:
            pass
    return parts[0], None


def _live_waiting(r, now: float) -> list:
    """Return ``[(member, scan_type, priority)]`` of live waiters, pruning stale ones."""
    live = []
    stale = []
    for member, score in r.zrange(_SCAN_WAITING_KEY, 0, -1, withscores=True):
        scan_type, ts = _parse_waiting_member(member)
        if ts is None or now - ts > _WAITING_STALE_SEC:
            stale.append(member)
            continue
        live.append((member, scan_type, SCAN_PRIORITY.get(scan_type, int(score))))
    if stale:
        try:
            r.zrem(_SCAN_WAITING_KEY, *stale)
        except Exception as exc:
            log.debug("scan waiting set pruning failed: %s", exc)
    return live


def _next_local_fence() -> int:
    """Return the next process-local fencing token (Redis disabled).

    Mirrors the Redis script: strictly increasing and floored at the current
    time in microseconds so a process restart never reissues a smaller token.
    """
    global _LOCAL_LAST_FENCE
    with _LOCAL_FENCE_LOCK:
        _LOCAL_LAST_FENCE = max(_LOCAL_LAST_FENCE + 1, time.time_ns() // 1000)
        return _LOCAL_LAST_FENCE


def fence_token_of(lock_token: Optional[str]) -> Optional[int]:
    """Extract the fencing token from a scan lock owner token.

    Returns None for tokens without a fencing suffix (legacy or test tokens);
    such leases are not fenced in the database.
    """
    if not lock_token or not isinstance(lock_token, str):
        return None
    _, sep, suffix = lock_token.rpartition(":")
    if not sep or not suffix.isdigit():
        return None
    return int(suffix)


def acquire_scan_lock(scan_type: str, timeout: int = 300) -> Optional[str]:
    """Acquire the distributed scan lock for the given scan type.

    Blocks up to *timeout* seconds waiting for the lock.  Returns an opaque
    owner token on success, ``None`` on timeout or when a higher-priority scan
    is waiting.  The token must be passed to :func:`release_scan_lock` and
    :func:`renew_scan_lock`; ownership is enforced by compare-and-delete so a
    stale caller can never release a lock owned by someone else.  The token
    embeds a strictly increasing fencing token (see :func:`fence_token_of`)
    that guarded scan transactions write to the ``lease_fences`` table.

    Redis keys used:
      - ``scan:lock``          -- simple mutex (NX, TTL), value = owner token
      - ``scan:active_type``   -- which scan type currently holds the lock
      - ``scan:waiting``       -- sorted set of waiters (member = type:ts:owner, score = priority)
      - ``net2map:fence:scan:lock`` -- fencing token counter (INCR on acquire)
    """
    global _LOCAL_ACTIVE_SCAN, _LOCAL_LOCK_TOKEN
    priority = SCAN_PRIORITY.get(scan_type, 1)
    owner_id = uuid.uuid4().hex

    r = get_redis()
    if not r:
        if redis_client.REDIS_URL:
            # A process-local fallback cannot serialize distributed workers.
            return None
        # Redis is deliberately disabled: single-process locking only.
        acquired = _LOCAL_SCAN_LOCK.acquire(timeout=timeout)
        if acquired:
            token = "%s:%d" % (owner_id, _next_local_fence())
            _LOCAL_ACTIVE_SCAN = scan_type
            _LOCAL_LOCK_TOKEN = token
            return token
        return None

    # Register ourselves as waiting so lower-priority dispatches can see us.
    # The member is unique per waiter, so two waiters of the same scan type
    # never remove each other's registration.
    registered_at = time.time()
    member = _waiting_member(scan_type, owner_id, registered_at)
    try:
        r.zadd(_SCAN_WAITING_KEY, {member: priority})
    except Exception:
        pass

    def _unregister(name):
        try:
            r.zrem(_SCAN_WAITING_KEY, name)
        except Exception:
            pass

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            now = time.time()
            if now - registered_at > _WAITING_STALE_SEC / 2:
                # Long waits refresh the registration before it counts as stale.
                _unregister(member)
                registered_at = now
                member = _waiting_member(scan_type, owner_id, registered_at)
                r.zadd(_SCAN_WAITING_KEY, {member: priority})

            # Check if a higher-priority scan is waiting (we should yield)
            if any(prio > priority for _, _, prio in _live_waiting(r, now)):
                # A higher-priority scan is waiting -- give up
                _unregister(member)
                return None

            # Try to acquire the mutex together with a new fencing token.
            # Any Redis error (including a failed INCR) fails this attempt.
            token = r.eval(
                _ACQUIRE_LOCK_LUA, 3,
                _SCAN_LOCK_KEY, _SCAN_ACTIVE_TYPE_KEY, _SCAN_LOCK_FENCE_KEY,
                owner_id, scan_type, _SCAN_LOCK_TTL,
            )
            if token:
                if isinstance(token, bytes):
                    token = token.decode()
                _unregister(member)
                return token

        except Exception:
            pass

        time.sleep(2)

    # Timed out -- remove ourselves from waiting set
    _unregister(member)
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
        r.eval(_RELEASE_LOCK_LUA, 2, _SCAN_LOCK_KEY, _SCAN_ACTIVE_TYPE_KEY, token)
        # Waiting set entries are removed by acquire_scan_lock itself (unique
        # members); a legacy plain-type member is cleaned up just in case.
        if scan_type:
            r.zrem(_SCAN_WAITING_KEY, scan_type)
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
        return bool(r.eval(_RENEW_LOCK_LUA, 2, _SCAN_LOCK_KEY, _SCAN_ACTIVE_TYPE_KEY, token, ttl))
    except Exception:
        return False


def get_active_scan_type() -> Optional[str]:
    """Return the scan type currently holding the lock, or None."""
    r = get_redis()
    if r:
        try:
            return r.get(_SCAN_ACTIVE_TYPE_KEY)
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
        active = r.get(_SCAN_ACTIVE_TYPE_KEY)
        if active:
            active_prio = SCAN_PRIORITY.get(active, 1)
            if active_prio >= priority:
                return False

        # Check waiting scans -- if anything with higher priority is waiting,
        # skip. Stale entries of crashed waiters are pruned while reading.
        if any(prio > priority for _, _, prio in _live_waiting(r, time.time())):
            return False

    except Exception:
        return False

    return True


# ── Scheduler dispatch claims (shared across Celery workers / beat restarts) ──

_SCHED_DISPATCH_KEY_PREFIX = "net2map:sched:last_dispatch:"

# In-memory fallback when Redis is unavailable (single process only).
_LOCAL_LAST_DISPATCH: Dict[str, float] = {}
_LOCAL_DISPATCH_LOCK = threading.Lock()

# Atomic compare-and-set claim for one scheduler interval. KEYS[1] holds the
# Redis server time (seconds) of the last dispatch; the claim succeeds only
# when no dispatch happened within ARGV[1] seconds. Using the server clock
# keeps workers with skewed local clocks consistent. ARGV[2] is the key TTL
# (garbage collection only; the comparison is authoritative, so changed
# intervals take effect on the next tick). On success the stored value is
# returned as the claim token (see release_scheduled_dispatch).
_CLAIM_DISPATCH_LUA = """
local now = redis.call("time")
local ts = tonumber(now[1]) + tonumber(now[2]) / 1000000
local last = tonumber(redis.call("get", KEYS[1]))
if last and ts - last < tonumber(ARGV[1]) then
    return 0
end
local value = string.format("%.6f", ts)
redis.call("set", KEYS[1], value, "EX", ARGV[2])
return value
"""

# Compare-and-delete rollback of a claim: only removes the stored timestamp
# while it is still the caller's own claim token.
_RELEASE_DISPATCH_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("del", KEYS[1])
    return 1
end
return 0
"""


def _dispatch_claim_ttl(interval: int) -> int:
    # Twice the interval so a raised interval is still honoured against the
    # stored timestamp; at least one minute, at most one week.
    return max(60, min(int(interval) * 2, 7 * 86400))


def claim_scheduled_dispatch_token(kind: str, interval: int) -> Optional[str]:
    """Claim the scheduler dispatch of ``kind`` for the current interval.

    Returns an opaque claim token for exactly one caller per interval across
    all processes sharing Redis (key ``net2map:sched:last_dispatch:<kind>``),
    so multiple Celery workers or a restarted beat cannot dispatch
    duplicates; None when the interval is already claimed. Pass the token to
    release_scheduled_dispatch when the dispatch was refused so the next tick
    can retry. Uses process-local timestamps only when Redis is not
    configured at all; with a configured but failing Redis the claim fails
    closed (no dispatch, retried on the next tick) because per-process
    timestamps cannot deduplicate across workers.
    """
    if interval <= 0:
        return None
    r = get_redis()
    if r:
        try:
            token = r.eval(
                _CLAIM_DISPATCH_LUA, 1, _SCHED_DISPATCH_KEY_PREFIX + kind,
                int(interval), _dispatch_claim_ttl(interval),
            )
        except Exception as exc:
            log.warning("scheduler dispatch claim via Redis failed for %s: %s", kind, exc)
            return None
        if not token or token == "0":
            return None
        return token.decode() if isinstance(token, bytes) else str(token)
    if redis_client.REDIS_URL:
        log.warning("scheduler dispatch claim for %s skipped: Redis configured but unavailable", kind)
        return None
    now = time.time()
    with _LOCAL_DISPATCH_LOCK:
        if now - _LOCAL_LAST_DISPATCH.get(kind, 0.0) < interval:
            return None
        _LOCAL_LAST_DISPATCH[kind] = now
        return "local:%r" % now


def claim_scheduled_dispatch(kind: str, interval: int) -> bool:
    """Boolean form of claim_scheduled_dispatch_token."""
    return claim_scheduled_dispatch_token(kind, interval) is not None


def release_scheduled_dispatch(kind: str, token: Optional[str]) -> bool:
    """Roll back a dispatch claim whose dispatch was refused.

    Race-free: only the caller's own claim is removed (compare-and-delete on
    the claim token); while the claim exists no other worker can claim the
    same interval, so a concurrent dispatch can never be undone. Returns True
    when the claim was removed. On Redis errors the claim stays (the interval
    is consumed, the previous behavior).
    """
    if not token:
        return False
    if token.startswith("local:"):
        try:
            ts = float(token[len("local:"):])
        except ValueError:
            return False
        with _LOCAL_DISPATCH_LOCK:
            if _LOCAL_LAST_DISPATCH.get(kind) == ts:
                del _LOCAL_LAST_DISPATCH[kind]
                return True
        return False
    r = get_redis()
    if not r:
        return False
    try:
        return bool(r.eval(_RELEASE_DISPATCH_LUA, 1, _SCHED_DISPATCH_KEY_PREFIX + kind, token))
    except Exception as exc:
        log.warning("scheduler dispatch claim release failed for %s: %s", kind, exc)
        return False
