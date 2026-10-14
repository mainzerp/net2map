"""Job management -- _run_scan_job and _start_job."""
import asyncio
import logging
import threading
import uuid
from datetime import datetime, timezone

from database import SessionLocal
from scan_engine.event_loop import _get_bg_loop
from scan_engine.executor import _execute_scan, get_dry_run_preview
from schemas import ScanResult
from shared.state import (
    _log_event,
    acquire_scan_lock,
    list_scan_jobs,
    release_scan_lock,
    set_scan_job,
    update_scan_job,
    update_scan_job_if_status,
)

# Jobs waiting for a Celery worker longer than this are marked failed: no
# worker consumed the task (worker down, broker/queue misconfiguration).
STALE_QUEUED_JOB_TIMEOUT_SEC = 15 * 60
_STALE_JOB_STATUSES = ("queued", "retrying")
STALE_QUEUED_JOB_ERROR = (
    "Scan job was not picked up by a Celery worker within %d minutes; "
    "check that the worker is running and consuming the queue"
)


def _parse_iso(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def reap_stale_queued_jobs(now: datetime | None = None,
                           timeout_sec: int = STALE_QUEUED_JOB_TIMEOUT_SEC) -> list:
    """Mark jobs stuck in "queued"/"retrying" longer than ``timeout_sec`` as failed.

    The age is measured from ``status_at`` (set when a job enters "retrying")
    or else ``started_at`` (the enqueue time). The update is conditional on
    the status still being queued/retrying, so a job a worker just picked up
    is never overwritten. Returns the reaped job ids. Never raises.
    """
    now = now or datetime.now(timezone.utc)
    reaped = []
    try:
        jobs = list_scan_jobs()
    except Exception as exc:
        _log_event(logging.WARNING, "scan.job.reaper_failed", error=str(exc))
        return reaped
    for job_id, job in jobs.items():
        if not isinstance(job, dict) or job.get("status") not in _STALE_JOB_STATUSES:
            continue
        since = _parse_iso(job.get("status_at")) or _parse_iso(job.get("started_at"))
        if since is None or (now - since).total_seconds() < timeout_sec:
            continue
        message = STALE_QUEUED_JOB_ERROR % (timeout_sec // 60)
        applied = update_scan_job_if_status(job_id, _STALE_JOB_STATUSES, {
            "status": "failed",
            "finished_at": now.isoformat(),
            "result": {"errors": [message]},
            "reaped": True,
        })
        if applied:
            reaped.append(job_id)
            _log_event(logging.WARNING, "scan.job.reaped", correlation_id=job_id, job_id=job_id,
                       previous_status=job.get("status"), error=message)
    return reaped


def _run_scan_job(job_id: str, cancel_event: threading.Event, dry_run: bool = False, scan_type: str = "full"):
    # Acquire the distributed scan lock (same as the scheduler and Celery
    # paths) so manually started scans cannot run concurrently with another
    # scan and corrupt the bulk-delete/re-insert cycles on ports,
    # topology_links and endpoints.
    lock_token = acquire_scan_lock(scan_type, timeout=60)
    if not lock_token:
        _log_event(logging.WARNING, "scan.job.lock_conflict",
                   correlation_id=job_id, job_id=job_id, scan_type=scan_type)
        update_scan_job(job_id, {
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "result": {"skipped": True, "reason": "scan_lock_conflict"},
            "status": "failed",
        })
        return

    db = SessionLocal()
    result = None
    try:
        loop = _get_bg_loop()
        future = asyncio.run_coroutine_threadsafe(
            _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run,
                          scan_type=scan_type, lock_token=lock_token),
            loop,
        )
        # Deliberately no timeout: this dedicated job thread must not release
        # the scan lock (finally below) while the coroutine still runs. The
        # scan is bounded by its own cancel_event, per-target SNMP timeouts
        # and lease checks (it aborts when the lock cannot be renewed).
        result = future.result()
    except Exception as exc:
        result = ScanResult(
            scanned=0,
            found=0,
            links=0,
            errors=[str(exc)],
            max_workers=1,
            total_duration_ms=0,
            switch_metrics=[],
            status="failed",
        )
    finally:
        release_scan_lock(lock_token, scan_type)
        db.close()

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


def _start_job(dry_run: bool = False, scan_type: str = "full") -> dict:
    job_id = str(uuid.uuid4())

    # Try Celery dispatch if Redis is available
    from shared.redis_client import get_redis
    if get_redis():
        try:
            from tasks import run_scan_task
            set_scan_job(job_id, {
                "id": job_id,
                "status": "queued",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "result": None,
                "cancel_requested": False,
            })
            run_scan_task.delay(job_id, dry_run, scan_type)
            _log_event(logging.INFO, "scan.job.start", correlation_id=job_id, job_id=job_id, dry_run=dry_run, backend="celery")
            return {"job_id": job_id, "status": "queued"}
        except Exception as exc:
            _log_event(logging.WARNING, "scan.job.celery_fallback", error=str(exc))

    # Thread-based fallback
    cancel_event = threading.Event()
    set_scan_job(job_id, {
        "id": job_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "result": None,
        "cancel_requested": False,
        "cancel_event": cancel_event,
        "thread": None,
    })

    t = threading.Thread(target=_run_scan_job, args=(job_id, cancel_event, dry_run, scan_type), daemon=True)
    update_scan_job(job_id, {"thread": t})
    t.start()
    _log_event(logging.INFO, "scan.job.start", correlation_id=job_id, job_id=job_id, dry_run=dry_run, backend="thread")

    return {"job_id": job_id, "status": "running"}
