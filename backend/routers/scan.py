"""Scan trigger and job management endpoints."""
import logging
import uuid

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import get_db
from scan_engine import _execute_scan, _start_job
from schemas import ScanResult
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.state import _log_event, get_scan_job, request_scan_cancel

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.post("/api/scan", response_model=ScanResult, deprecated=True,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("2/minute")
async def run_scan(request: Request, db: Session = Depends(get_db)):
    """Synchronous scan execution. Deprecated: use POST /api/scan/jobs instead."""
    log_audit(request, "scan", "scan", "", {"mode": "sync"})
    return await _execute_scan(db, None, correlation_id=f"sync-{uuid.uuid4()}")


@router.post("/api/scan/jobs",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
def start_scan_job(request: Request):
    """Start background scan job and return job ID immediately."""
    result = _start_job(dry_run=False)
    log_audit(request, "scan", "scan_job", result.get("job_id", ""), {"mode": "background"})
    return result


@router.post("/api/scan/dry-run/jobs",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("3/minute")
def start_dry_run_job(request: Request):
    """Start a background dry-run discovery job. Returns job ID immediately.
    Poll /api/scan/jobs/{job_id} for results; result will contain a 'preview' key."""
    return _start_job(dry_run=True)


@router.get("/api/scan/jobs/{job_id}")
def get_scan_job_status(job_id: str):
    state = get_scan_job(job_id)
    if not state:
        api_error(404, "SCAN_JOB_NOT_FOUND", "Scan job not found")
    return {
        "id": state["id"],
        "status": state["status"],
        "started_at": state.get("started_at"),
        "finished_at": state.get("finished_at"),
        "cancel_requested": state.get("cancel_requested", False),
        "result": state.get("result"),
    }


@router.post("/api/scan/jobs/{job_id}/cancel",
             dependencies=[require_role("admin", "operator")])
def cancel_scan_job(job_id: str, request: Request):
    state = get_scan_job(job_id)
    if not state:
        api_error(404, "SCAN_JOB_NOT_FOUND", "Scan job not found")
    if state["status"] not in ("running", "queued"):
        return {"id": job_id, "status": state["status"], "cancel_requested": state.get("cancel_requested", False)}
    request_scan_cancel(job_id)
    _log_event(logging.WARNING, "scan.job.cancel_requested", correlation_id=job_id, job_id=job_id)
    return {"id": job_id, "status": state["status"], "cancel_requested": True}
