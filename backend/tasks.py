"""Celery tasks for NetMap background scan execution."""
import asyncio
import logging
import threading
from datetime import datetime, timezone

from celery_app import celery_app
from database import SessionLocal
from scan_engine import _execute_scan
from schemas import ScanResult
from shared.state import (
    update_scan_job, is_cancel_requested, _log_event,
    acquire_scan_lock, release_scan_lock,
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
