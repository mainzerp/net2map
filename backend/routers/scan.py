"""Scan trigger and job management endpoints."""
import asyncio
import logging

from fastapi import APIRouter, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from scan_engine import _start_job
from schemas import ScanResult
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.state import _log_event, get_scan_job, request_scan_cancel

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

_TERMINAL_JOB_STATUSES = {"finished", "failed", "cancelled", "skipped", "dry_run"}


@router.post("/scan", response_model=ScanResult, deprecated=True,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("2/minute")
async def run_scan(request: Request):
    """Synchronous scan execution. Deprecated: use POST /api/v1/scan/jobs instead.

    Internally this dispatches through the background job path
    (scan_engine.jobs._start_job) and asynchronously polls for completion
    instead of running the scan inline on the API event loop. The response
    shape (ScanResult) is unchanged.
    """
    log_audit(request, "scan", "scan", "", {"mode": "sync"})
    job = _start_job(dry_run=False, scan_type="full")
    job_id = job["job_id"]

    loop = asyncio.get_running_loop()
    deadline = loop.time() + 600
    while loop.time() < deadline:
        state = get_scan_job(job_id)
        if state and state.get("status") in _TERMINAL_JOB_STATUSES:
            result_data = state.get("result") or {}
            if not isinstance(result_data, dict) or "scanned" not in result_data:
                # Lock conflict / skipped: no ScanResult-shaped payload
                api_error(409, "SCAN_CONFLICT", "Scan could not be started (another scan is active)")
            fields = {k: v for k, v in result_data.items() if k in ScanResult.model_fields}
            return ScanResult(**fields)
        await asyncio.sleep(1)

    api_error(504, "SCAN_TIMEOUT", "Scan did not finish within the polling window")


@router.post("/scan/jobs",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
def start_scan_job(request: Request):
    """Start background scan job and return job ID immediately."""
    result = _start_job(dry_run=False)
    log_audit(request, "scan", "scan_job", result.get("job_id", ""), {"mode": "background"})
    return result


@router.post("/scan/dry-run/jobs",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("3/minute")
def start_dry_run_job(request: Request):
    """Start a background dry-run discovery job. Returns job ID immediately.
    Poll /api/v1/scan/jobs/{job_id} for results; result will contain a 'preview' key."""
    return _start_job(dry_run=True)


@router.get("/scan/jobs/{job_id}")
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


@router.post("/scan/jobs/{job_id}/cancel",
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
