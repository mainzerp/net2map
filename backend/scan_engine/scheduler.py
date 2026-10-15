"""Background scheduler -- periodic scan dispatch."""
import asyncio
import logging
import threading
import time
import uuid
from datetime import datetime, timezone

from database import AppSetting, SessionLocal
from scan_engine.event_loop import _get_bg_loop
from scan_engine.executor import _execute_scan
from shared.scan_ranges import any_scan_range_due
from shared.state import _log_event, can_dispatch_scan, set_scan_job, update_scan_job

# Range scans are dispatched when at least one enabled range is due; the due
# check (a DB query) runs at most this often.
RANGES_CHECK_INTERVAL_SEC = 60

# Wake event: set this to interrupt the scheduler sleep early (e.g. when
# settings change and the scheduler should re-evaluate intervals immediately).
_scheduler_wake = threading.Event()

# Shutdown flag: set this to signal the scheduler to exit its loop.
_shutdown_requested = threading.Event()


# Scan types whose last dispatch attempt was refused (another scan active or
# waiting, lock not acquired). Refused dispatches are retried on every tick;
# to keep the log readable only the first refusal of such a streak and the
# eventual dispatch are logged.
_blocked_kinds: set = set()
_blocked_lock = threading.Lock()


def _mark_blocked(scan_type: str) -> bool:
    """Record a refused dispatch; True when this starts a new blocked streak."""
    with _blocked_lock:
        if scan_type in _blocked_kinds:
            return False
        _blocked_kinds.add(scan_type)
        return True


def _clear_blocked(scan_type: str) -> None:
    """End a blocked streak; logs once that the dispatch went through."""
    with _blocked_lock:
        was_blocked = scan_type in _blocked_kinds
        _blocked_kinds.discard(scan_type)
    if was_blocked:
        _log_event(logging.INFO, "scheduler.%s.resumed" % scan_type)


def _log_dispatch_start(scan_type: str) -> None:
    """Log a dispatch attempt unless the type is in a blocked streak (retries)."""
    with _blocked_lock:
        blocked = scan_type in _blocked_kinds
    if not blocked:
        _log_event(logging.INFO, "scheduler.%s.start" % scan_type)


def _scan_blocked(scan_type: str) -> bool:
    """True when a higher-priority scan is running or waiting (can_dispatch_scan).

    Logs the skip once per blocked streak instead of on every retry tick.
    """
    if can_dispatch_scan(scan_type):
        return False
    if _mark_blocked(scan_type):
        _log_event(logging.INFO, "scheduler.%s.skipped" % scan_type,
                   reason="higher_priority_scan_active_or_waiting", retry="next_tick")
    return True


def shutdown_scheduler():
    """Signal the background scheduler to exit its loop."""
    _shutdown_requested.set()
    _scheduler_wake.set()  # wake it immediately so it exits


def _read_scheduler_intervals(db) -> dict:
    """Read scheduler interval settings. Shared by the thread-based scheduler
    loop and the Celery ``scheduler_tick`` task.

    Returns ``{"discovery": int, "links": int, "macs": int}`` in seconds.
    """
    discovery_setting = db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
    links_setting = db.query(AppSetting).filter(AppSetting.key == "link_update_interval_sec").first()
    macs_setting = db.query(AppSetting).filter(AppSetting.key == "mac_update_interval_sec").first()
    ports_legacy_setting = db.query(AppSetting).filter(AppSetting.key == "port_update_interval_sec").first()

    discovery_interval = int(discovery_setting.value) if discovery_setting else 1800
    legacy_ports_interval = int(ports_legacy_setting.value) if ports_legacy_setting else None
    # Fallbacks match the seeded defaults in database._seed_default_settings.
    links_interval = int(links_setting.value) if links_setting else (legacy_ports_interval or 60)
    macs_interval = int(macs_setting.value) if macs_setting else (legacy_ports_interval or 300)
    return {"discovery": discovery_interval, "links": links_interval, "macs": macs_interval}


def _ranges_due() -> bool:
    """True when at least one enabled scan range is due (short-lived session)."""
    db = SessionLocal()
    try:
        return any_scan_range_due(db)
    finally:
        db.close()


def _dispatch_scheduled_scan(scan_type: str) -> bool:
    """Run a scheduled scan, using Celery if available, otherwise directly.

    Checks the distributed scan lock before dispatching: if a higher-priority
    scan is running or waiting, this scan is skipped.

    Returns True when the scan was dispatched (queued or started) and False
    when it was not (another scan active/waiting, lock not acquired), so the
    thread-based scheduler retries on its next tick instead of waiting a
    full interval.
    """
    if _scan_blocked(scan_type):
        return False

    from shared.redis_client import get_redis
    if get_redis():
        job_id = None
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
            _clear_blocked(scan_type)
            _log_event(logging.INFO, "scheduler.%s.dispatched" % scan_type, backend="celery")
            return True
        except Exception as exc:
            if job_id is not None:
                update_scan_job(job_id, {
                    "status": "failed",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "result": {"errors": ["Failed to enqueue scheduled scan"]},
                })
            _log_event(logging.WARNING, "scheduler.celery_fallback", error=str(exc), scan_type=scan_type)

    # Direct execution fallback (also needs lock). The scan itself runs on the
    # shared background event loop; completion is tracked via a done-callback
    # so the scheduler thread never blocks on future.result() and can keep
    # dispatching lower-priority scan types in order.
    from shared.state import acquire_scan_lock, release_scan_lock
    lock_token = acquire_scan_lock(scan_type, timeout=60)
    if not lock_token:
        if _mark_blocked(scan_type):
            _log_event(logging.INFO, "scheduler.%s.lock_timeout" % scan_type, retry="next_tick")
        return False
    _clear_blocked(scan_type)

    db = SessionLocal()
    loop = _get_bg_loop()
    future = asyncio.run_coroutine_threadsafe(
        _execute_scan(db, scan_type=scan_type, lock_token=lock_token), loop,
    )

    def _on_done(fut):
        try:
            fut.result()
        except Exception as e:
            _log_event(logging.ERROR, "scheduler.%s.error" % scan_type, error=str(e))
        finally:
            release_scan_lock(lock_token, scan_type)
            db.close()

    future.add_done_callback(_on_done)
    return True


def _background_scheduler():
    """Runs discovery, link, MAC and range scans periodically based on app settings."""
    last_discovery = 0
    last_links = 0
    last_macs = 0
    last_ranges_check = 0

    while not _shutdown_requested.is_set():
        _scheduler_wake.wait(timeout=5)
        _scheduler_wake.clear()
        if _shutdown_requested.is_set():
            break

        try:
            # Use a short-lived session only for reading settings
            settings_db = SessionLocal()
            try:
                intervals = _read_scheduler_intervals(settings_db)
            finally:
                settings_db.close()

            now = time.time()

            # Dispatch in priority order: macs > links > discovery > ranges
            # Higher-priority scans are dispatched first so they register
            # in the waiting set before lower-priority checks run.
            # The last_* timestamps only advance when the scan was actually
            # dispatched; otherwise the next tick retries.
            if intervals["macs"] > 0 and (now - last_macs) >= intervals["macs"]:
                _log_dispatch_start("macs")
                if _dispatch_scheduled_scan("macs"):
                    last_macs = time.time()

            if intervals["links"] > 0 and (now - last_links) >= intervals["links"]:
                _log_dispatch_start("links")
                if _dispatch_scheduled_scan("links"):
                    last_links = time.time()

            if intervals["discovery"] > 0 and (now - last_discovery) >= intervals["discovery"]:
                _log_dispatch_start("discovery")
                if _dispatch_scheduled_scan("discovery"):
                    last_discovery = time.time()

            # Range scans run when a range is due; checked at most once a minute.
            if (now - last_ranges_check) >= RANGES_CHECK_INTERVAL_SEC:
                last_ranges_check = now
                if _ranges_due():
                    _log_dispatch_start("ranges")
                    _dispatch_scheduled_scan("ranges")

        except Exception as e:
            _log_event(logging.ERROR, "scheduler.error", error=str(e))

    _log_event(logging.INFO, "scheduler.shutdown")
