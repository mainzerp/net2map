# Scan Engine Locking & Scheduling Analysis

## 1. File Inventory & Key Line Numbers

### backend/scan_engine.py (main file, ~1230 lines)

| Function / Symbol | Line | Purpose |
|---|---|---|
| `_bg_loop_lock` | 72 | `threading.Lock()` -- only lock in the entire scan engine; guards lazy init of the shared asyncio event loop |
| `_get_bg_loop()` | 75 | Returns/creates the background asyncio event loop (lazy singleton) |
| `_execute_scan()` | 310-1040 | Core async scan logic -- discovery, SNMP polling, port/link/MAC writes |
| `update_ports` / `update_links` flags | 822-823 | Determine which DB writes happen based on `scan_mode` |
| Port DELETE + bulk INSERT | 852-887 | Per-device: deletes all ports, re-inserts. Commits per-device inside `for ip, sw` loop |
| Link DELETE + INSERT | 899-986 | Deletes all TopologyLinks for scanned IPs, re-inserts. Single commit at end |
| `_persist_scan_run()` | (called at 1011) | Records scan run + metrics to DB |
| `_run_scan_job()` | 1044-1080 | Thread-based wrapper: opens DB session, runs `_execute_scan` on the bg loop, blocks on result |
| `_start_job()` | 1082-1129 | Entry point for manual/API scans. Tries Celery dispatch, falls back to thread |
| `_scheduler_wake` | 1127 | `threading.Event()` -- used to interrupt scheduler sleep when settings change |
| `_dispatch_scheduled_scan()` | 1132-1165 | Dispatches a single scheduled scan type via Celery (or direct fallback) |
| `_background_scheduler()` | 1167-1230 | Infinite loop: reads intervals from DB, dispatches discovery/links/macs scans independently |

### backend/shared/state.py (~255 lines)

| Function | Line | Purpose |
|---|---|---|
| `_log_event()` | 33 | Structured logging to Redis list `netmap:logs` (or in-memory deque) |
| `set_scan_job()` | 96 | Stores job dict in Redis hash `netmap:scan_jobs`; non-serializable fields (cancel_event, thread) kept in `_LOCAL_JOB_META` |
| `get_scan_job()` | 119 | Retrieves job dict, merges Redis data with local metadata |
| `update_scan_job()` | 133 | Merges updates into existing job state |
| `delete_scan_job()` | 159 | Removes job from Redis + local stores |
| `list_scan_jobs()` | 177 | Returns all jobs as dict |
| `request_scan_cancel()` | 199 | Sets `cancel_requested` flag in Redis + triggers local `cancel_event` |
| `is_cancel_requested()` | 230 | Checks Redis flag + local event |

Redis keys used:
- `netmap:scan_jobs` -- Hash: `{job_id -> JSON(job_state)}`
- `netmap:logs` -- List (capped at 5000 entries)

### backend/shared/redis_client.py (~27 lines)

- Simple lazy-init `ConnectionPool` from `REDIS_URL` env var
- `get_redis()` returns a `redis.Redis` client or `None`
- `decode_responses=True` -- all values returned as strings
- No distributed lock utilities exist here

### backend/celery_app.py (~17 lines)

```python
celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL, include=["tasks"])
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)
```

Key settings:
- `task_acks_late=True` -- task acknowledged only after completion (good for reliability)
- `worker_prefetch_multiplier=1` -- each worker only pre-fetches 1 task at a time
- No `task_routes`, no priority queues, no rate limiting configured

### backend/tasks.py (~65 lines)

| Symbol | Line | Purpose |
|---|---|---|
| `_RedisCancelEvent` | 13 | Adapts Redis-based cancel flag to `threading.Event` interface for use in Celery workers |
| `run_scan_task()` | 25 | `@celery_app.task(bind=True, max_retries=2)` -- creates its own asyncio loop, calls `_execute_scan()` directly |

The Celery task:
1. Sets job status to "running"
2. Creates a `_RedisCancelEvent(job_id)` for cancellation
3. Opens a new `SessionLocal()` DB session
4. Creates a **new** asyncio event loop per task execution
5. Calls `_execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run, scan_type=scan_type)`
6. On failure, retries up to 2 times with 10s delay

### docker-compose.yml (celery-worker service, lines 80-107)

```yaml
celery-worker:
    build: ./backend
    container_name: netmap-celery
    restart: unless-stopped
    command: celery -A celery_app worker --loglevel=info --concurrency=2
    environment:
      DATABASE_URL: "postgresql://..."
      REDIS_URL: "redis://redis:6379/0"
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:-}"
    volumes:
      - netmap-data:/data
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
```

**Current concurrency: 2** (line 86: `--concurrency=2`)

---

## 2. Current Locking Mechanisms

### What EXISTS

1. **`_bg_loop_lock`** (scan_engine.py:72) -- `threading.Lock` guarding lazy initialization of the singleton asyncio event loop. Only used within one process; irrelevant for distributed locking.

2. **`SCAN_JOBS_LOCK`** (state.py:20) -- `threading.Lock` guarding the in-memory `SCAN_JOBS` dict fallback. Only used when Redis is unavailable.

3. **`LOG_BUFFER_LOCK`** (state.py:17) -- `threading.Lock` guarding the in-memory log buffer fallback.

### What DOES NOT EXIST

- **No distributed lock** of any kind. No Redis `SETNX`, no `redis.lock()`, no `aioredis` lock, no Celery `solo` pool, no DB advisory locks.
- **No DB-level row locking** -- no `SELECT ... FOR UPDATE`, no `with_for_update()` calls.
- **No Celery task deduplication** -- no `task_reject_on_worker_lost`, no unique task enforcement, no `celery-singleton` or `celery-once`.
- **No mutual exclusion between scan types** -- discovery, links, and macs scans can all run concurrently.
- **No priority queue** -- all tasks go to the default Celery queue with equal priority.

---

## 3. Scan Type Flow & Overlap Risk

### How scan_type propagates

```
_background_scheduler()        -- determines which scan types are due
  -> _dispatch_scheduled_scan(scan_type)  -- e.g. "discovery", "links", "macs"
       -> run_scan_task.delay(job_id, False, scan_type)   [Celery]
            -> _execute_scan(db, cancel_event, ..., scan_type=scan_type)
```

Manual scans (from API):
```
_start_job(dry_run, scan_type)
  -> run_scan_task.delay(job_id, dry_run, scan_type)   [Celery]
       -> _execute_scan(db, ..., scan_type=scan_type)
```

### scan_mode determines DB writes

| scan_type | update_ports (L822) | update_links (L823) | Credential scope |
|---|---|---|---|
| `full` | YES | YES | All enabled credentials |
| `discovery` | NO | NO | All enabled credentials |
| `ports` | YES | YES | Known (non-ignored) device IPs only |
| `links` | NO | YES | Known device IPs only |
| `macs` | YES | NO | Known device IPs only |

### Overlap danger zones

The scheduler dispatches all three types independently (lines 1211-1223):
```python
if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
    _dispatch_scheduled_scan("discovery")   # queued to Celery
    last_discovery = time.time()

if links_interval > 0 and (now - last_links) >= links_interval:
    _dispatch_scheduled_scan("links")       # queued to Celery
    last_links = time.time()

if macs_interval > 0 and (now - last_macs) >= macs_interval:
    _dispatch_scheduled_scan("macs")        # queued to Celery
    last_macs = time.time()
```

With concurrency=2 (and proposed concurrency=4), multiple scans can execute simultaneously:

**Conflict 1: macs + links running concurrently**
- `macs` scan: DELETE all ports for device X, bulk INSERT new ports (line 852-887)
- `links` scan: DELETE all topology links for scanned IPs, INSERT new links (line 899-986)
- Both read `switch_data` from live SNMP queries -- could get inconsistent snapshots

**Conflict 2: macs + macs (if interval is short and scan takes longer than interval)**
- Two macs scans DELETE the same device's ports simultaneously
- Race condition on `db.query(Port).filter(Port.device_id == device.id).delete()` (line 852)

**Conflict 3: discovery + links/macs**
- Discovery may add new devices to DB (lines 779-819)
- Concurrent links/macs scans filter by `known_ips` at start -- may miss newly discovered devices or conflict on Device writes

### DB write pattern (no transactions spanning full scan)

Port writes (per-device, inside loop):
```python
# Line 852: DELETE all ports for this device
db.query(Port).filter(Port.device_id == device.id).delete()
# Lines 854-886: build port_rows list
db.bulk_insert_mappings(Port, port_rows)
# Line 887: COMMIT
db.commit()
```

Link writes (batch):
```python
# Line 899: DELETE all topology links for scanned IPs
db.query(TopologyLink).filter(TopologyLink.local_ip.in_(scanned_ips)).delete(synchronize_session=False)
# Lines 903-983: loop adding TopologyLink rows
db.add(TopologyLink(...))
# Line 986: COMMIT
db.commit()
```

No row-level locking, no advisory locks, no serializable isolation level.

---

## 4. Cancel Mechanism

- Each job gets a cancel event (either `threading.Event` for thread-based, or `_RedisCancelEvent` for Celery)
- `_execute_scan()` checks `cancel_event.is_set()` at multiple points:
  - Before port update block (line 825)
  - Inside port update loop per-device (line 834)
  - Before link update block (line 894)
  - Inside link loop per-switch (line 951)
- On cancel: `db.rollback()` and sets `status = "cancelled"`
- Cancel is cooperative -- no forced thread/task termination

---

## 5. Summary of Risks When Increasing Concurrency to 4

1. **No scan overlap prevention**: With 4 Celery workers, up to 4 scans can run simultaneously. The scheduler can queue discovery + links + macs in rapid succession (5-second wake cycle). Manual API scans add further overlap risk.

2. **Port table corruption**: Two concurrent `macs` scans (or `macs` + `full`) both DELETE and re-INSERT ports for the same device without any locking. This can cause lost data or integrity errors.

3. **Link table corruption**: Similarly, concurrent `links` scans DELETE and re-INSERT TopologyLink rows for overlapping IP sets.

4. **Inconsistent SNMP snapshots**: Two scans querying the same switch simultaneously may get different SNMP responses, leading to inconsistent topology data.

5. **Resource contention**: 4 concurrent scans each run SNMP queries + DB writes. With the default `max_workers=4` per scan, that's up to 16 concurrent SNMP sessions.

---

## 6. Proposed Lock Priority (User Requirement)

The user wants distributed locking with priority: **MACs (highest) > Links > Discovery**

This means:
- A MACs scan should be able to preempt or block links/discovery from starting
- A Links scan should block discovery but yield to MACs
- Discovery has lowest priority

Implementation considerations:
- Redis-based distributed lock (e.g., `redis.lock()` or manual `SET NX EX`) on a key like `netmap:scan_lock`
- Priority could be implemented via separate Celery queues with priority routing, or via a Redis-based priority semaphore
- The lock should be acquired before `_execute_scan()` starts and released after it completes
- Lock TTL must exceed the maximum expected scan duration to prevent premature expiration
- The lock check should happen in `run_scan_task` (tasks.py) and/or `_dispatch_scheduled_scan` (scan_engine.py)
