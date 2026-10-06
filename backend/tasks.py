"""Celery tasks for Net2Map background scan execution."""
import asyncio
import logging
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
    claim_scheduled_dispatch,
    is_cancel_requested,
    release_scan_lock,
    update_scan_job,
)


class _RedisCancelEvent:
    """Cancel event backed by Redis flag, compatible with threading.Event interface."""

    def __init__(self, job_id: str):
        self.job_id = job_id

    def is_set(self) -> bool:
        return is_cancel_requested(self.job_id)

    def set(self):
        from shared.state import request_scan_cancel
        request_scan_cancel(self.job_id)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=10)
def run_scan_task(self, job_id: str, dry_run: bool = False, scan_type: str = "full"):
    """Execute a network scan as a Celery task."""
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

    cancel_event = _RedisCancelEvent(job_id)
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
        update_scan_job(job_id, {"status": "retrying"})
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


@celery_app.task
def scheduler_tick():
    """Periodic scheduler tick -- replaces _background_scheduler loop body.

    Per-interval dispatch is claimed in Redis (claim_scheduled_dispatch), so
    several workers or a restarted beat never dispatch the same interval twice.
    """
    from scan_engine.scheduler import _dispatch_scheduled_scan, _read_scheduler_intervals

    db = SessionLocal()
    try:
        intervals = _read_scheduler_intervals(db)
    finally:
        db.close()

    # Dispatch in priority order: macs > links > discovery
    for kind in ("macs", "links", "discovery"):
        if intervals[kind] > 0 and claim_scheduled_dispatch(kind, intervals[kind]):
            _log_event(logging.INFO, "scheduler.%s.start" % kind)
            _dispatch_scheduled_scan(kind)


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
