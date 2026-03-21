"""Celery tasks for NetMap background scan execution."""
import asyncio
import logging
import time
from datetime import datetime, timezone

from celery_app import celery_app
from database import AppSetting, SessionLocal
from scan_engine import _execute_scan
from schemas import ScanResult
from shared.state import (
    _log_event,
    acquire_scan_lock,
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


_last_dispatch = {"discovery": 0, "links": 0, "macs": 0}


@celery_app.task
def scheduler_tick():
    """Periodic scheduler tick -- replaces _background_scheduler loop body."""
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


@celery_app.task
def purge_old_audit_logs():
    """Delete audit log entries older than AUDIT_RETENTION_DAYS."""
    from datetime import datetime, timedelta, timezone

    from config import settings
    from database import AuditLog, SessionLocal

    if settings.audit_retention_days <= 0:
        return

    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.audit_retention_days)
    db = SessionLocal()
    try:
        deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
        db.commit()
        _log_event(logging.INFO, "audit.purge.complete", deleted=deleted,
                   retention_days=settings.audit_retention_days)
    except Exception as exc:
        db.rollback()
        _log_event(logging.ERROR, "audit.purge.error", error=str(exc))
    finally:
        db.close()
