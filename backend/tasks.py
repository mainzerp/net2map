"""Celery tasks for Net2Map background scan execution."""
import asyncio
import logging
import threading
import time
from datetime import datetime, timezone

from celery.exceptions import Retry

from celery_app import celery_app
from database import SessionLocal
from scan_engine import _execute_scan
from scan_engine.executor import get_dry_run_preview
from schemas import ScanResult
from shared.state import (
    _log_event,
    acquire_scan_lock,
    claim_scheduled_dispatch_token,
    get_scan_job,
    is_cancel_requested,
    release_scan_lock,
    release_scheduled_dispatch,
    update_scan_job,
)

# Seconds between Redis polls of the cancel flag of a running Celery scan.
_CANCEL_POLL_INTERVAL_SEC = 1.5


class _RedisCancelEvent:
    """Cancel event backed by Redis flag, compatible with threading.Event interface.

    The scan calls is_set() on its asyncio loop (per target and per credential
    attempt), so it must not block on Redis: a daemon thread polls the flag
    every _CANCEL_POLL_INTERVAL_SEC seconds and is_set() only reads the cached
    result. Once observed, a cancellation stays set.
    """

    def __init__(self, job_id: str, poll_interval: float = _CANCEL_POLL_INTERVAL_SEC):
        self.job_id = job_id
        self._poll_interval = poll_interval
        self._flag = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "_RedisCancelEvent":
        """Read the flag once synchronously, then start the background poller."""
        self._poll_once()
        if not self._flag.is_set() and self._thread is None:
            self._thread = threading.Thread(
                target=self._poll_loop, name="net2map-cancel-%s" % self.job_id, daemon=True,
            )
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._poll_interval + 1)
            self._thread = None

    def _poll_once(self) -> None:
        try:
            if is_cancel_requested(self.job_id):
                self._flag.set()
        except Exception as exc:
            _log_event(logging.DEBUG, "celery.task.cancel_poll_failed", job_id=self.job_id, error=str(exc))

    def _poll_loop(self) -> None:
        while not self._stop.wait(self._poll_interval):
            self._poll_once()
            if self._flag.is_set():
                return

    def is_set(self) -> bool:
        return self._flag.is_set()

    def set(self):
        from shared.state import request_scan_cancel
        self._flag.set()
        request_scan_cancel(self.job_id)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=10)
def run_scan_task(self, job_id: str, dry_run: bool = False, scan_type: str = "full"):
    """Execute a network scan as a Celery task."""
    job = get_scan_job(job_id)
    if job and job.get("reaped"):
        # The stale job reaper already failed this job (no worker picked it up
        # in time); a late delivery must not resurrect it.
        _log_event(logging.WARNING, "celery.task.reaped_job_skipped", job_id=job_id, scan_type=scan_type)
        return
    # Acquire distributed scan lock (wait up to 5 min)
    lock_token = acquire_scan_lock(scan_type, timeout=300)
    if not lock_token:
        _log_event(logging.WARNING, "celery.task.lock_skipped",
                   job_id=job_id, scan_type=scan_type)
        update_scan_job(job_id, {
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "result": {"skipped": True, "reason": "scan_lock_priority"},
            "status": "skipped",
        })
        return

    update_scan_job(job_id, {"status": "running"})

    cancel_event = _RedisCancelEvent(job_id).start()
    db = SessionLocal()
    result = None
    terminal_error = None
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(
            _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run,
                          scan_type=scan_type, lock_token=lock_token)
        )
    except Exception as exc:
        _log_event(logging.ERROR, "celery.task.error", job_id=job_id, error=str(exc))
        result = ScanResult(
            scanned=0, found=0, links=0,
            errors=[str(exc)], max_workers=1,
            total_duration_ms=0, switch_metrics=[], status="failed",
        )
        # Mark the job as retrying so a crashed/hanging worker never leaves a
        # permanent "running" status behind.
        update_scan_job(job_id, {"status": "retrying", "status_at": datetime.now(timezone.utc).isoformat()})
        try:
            self.retry(exc=exc)
        except Retry:
            raise
        except Exception as retry_exc:
            # Celery raises the original error when retry(exc=...) is exhausted,
            # and can also fail to enqueue the retry. Both are terminal states.
            _log_event(logging.ERROR, "celery.task.retry_failed", job_id=job_id, error=str(retry_exc))
            terminal_error = retry_exc
    finally:
        cancel_event.stop()
        release_scan_lock(lock_token, scan_type)
        db.close()
        loop.close()

    if result is None:
        return

    result_dict = result.model_dump()
    if dry_run:
        result_dict["preview"] = get_dry_run_preview(result)

    update_scan_job(job_id, {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "result": result_dict,
        "status": result.status if result.status in {"finished", "cancelled", "dry_run"} else "failed",
    })
    if terminal_error is not None:
        # Keep Celery's task state consistent with the persisted Net2Map job.
        raise terminal_error


# Minimum seconds between two stale job reaper runs in this process (the
# scheduler tick fires every few seconds; the reaper reads all job entries).
_REAPER_INTERVAL_SEC = 60.0
_last_reap = 0.0


def _maybe_reap_stale_jobs() -> None:
    """Fail jobs stuck in queued/retrying (throttled, never raises)."""
    global _last_reap
    now = time.monotonic()
    if _last_reap and now - _last_reap < _REAPER_INTERVAL_SEC:
        return
    _last_reap = now
    try:
        from scan_engine.jobs import reap_stale_queued_jobs
        reap_stale_queued_jobs()
    except Exception as exc:
        _log_event(logging.WARNING, "scheduler.reaper_error", error=str(exc))


@celery_app.task
def scheduler_tick():
    """Periodic scheduler tick -- replaces _background_scheduler loop body.

    Per-interval dispatch is claimed in Redis (claim_scheduled_dispatch_token),
    so several workers or a restarted beat never dispatch the same interval
    twice. The interval is only consumed when a scan was queued/started: a
    refused dispatch rolls its own claim back so the next tick retries.
    """
    from scan_engine.scheduler import (
        RANGES_CHECK_INTERVAL_SEC,
        _dispatch_scheduled_scan,
        _log_dispatch_start,
        _ranges_due,
        _read_scheduler_intervals,
        _scan_blocked,
    )

    _maybe_reap_stale_jobs()

    db = SessionLocal()
    try:
        intervals = _read_scheduler_intervals(db)
    finally:
        db.close()

    # Dispatch in priority order: macs > links > discovery > ranges
    for kind in ("macs", "links", "discovery"):
        interval = intervals[kind]
        if interval <= 0:
            continue
        # Cheap pre-check: no claim churn while a higher-priority scan runs.
        if _scan_blocked(kind):
            continue
        token = claim_scheduled_dispatch_token(kind, interval)
        if not token:
            continue
        _log_dispatch_start(kind)
        if not _dispatch_scheduled_scan(kind):
            # Refused after claiming (scan lock state changed in between):
            # roll back only our own claim so the next tick retries.
            release_scheduled_dispatch(kind, token)

    # Range scans: dispatched only when at least one enabled range is due; the
    # claim (at most one dispatch per minute) is taken only in that case.
    if not _scan_blocked("ranges") and _ranges_due():
        token = claim_scheduled_dispatch_token("ranges", RANGES_CHECK_INTERVAL_SEC)
        if token:
            _log_dispatch_start("ranges")
            if not _dispatch_scheduled_scan("ranges"):
                release_scheduled_dispatch("ranges", token)


@celery_app.task
def purge_old_audit_logs():
    """Delete audit log entries older than the effective retention.

    Retention comes from the ``audit_retention_days`` app setting when it is a
    positive integer, else AUDIT_RETENTION_DAYS (see get_audit_retention_days).
    """
    from datetime import datetime, timedelta, timezone

    from database import AuditLog, SessionLocal
    from shared.audit import get_audit_retention_days

    db = SessionLocal()
    try:
        retention_days = get_audit_retention_days(db)
        if retention_days <= 0:
            return
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
        deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
        db.commit()
        _log_event(logging.INFO, "audit.purge.complete", deleted=deleted,
                   retention_days=retention_days)
    except Exception as exc:
        db.rollback()
        _log_event(logging.ERROR, "audit.purge.error", error=str(exc))
    finally:
        db.close()
