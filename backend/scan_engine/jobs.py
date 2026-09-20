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
    release_scan_lock,
    set_scan_job,
    update_scan_job,
)


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
        result = future.result()  # blocks until done
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
