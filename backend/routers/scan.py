"""Scan trigger and job management endpoints."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from scan_engine import _execute_scan, _start_job
from schemas import ScanResult
from shared.state import SCAN_JOBS, SCAN_JOBS_LOCK, _log_event
import logging

router = APIRouter()


@router.post("/api/scan", response_model=ScanResult)
async def run_scan(db: Session = Depends(get_db)):
    """Synchronous scan execution (compatibility endpoint)."""
    return await _execute_scan(db, None, correlation_id=f"sync-{uuid.uuid4()}")


@router.post("/api/scan/jobs")
def start_scan_job():
    """Start background scan job and return job ID immediately."""
    return _start_job(dry_run=False)


@router.post("/api/scan/dry-run/jobs")
def start_dry_run_job():
    """Start a background dry-run discovery job. Returns job ID immediately.
    Poll /api/scan/jobs/{job_id} for results; result will contain a 'preview' key."""
    return _start_job(dry_run=True)


@router.get("/api/scan/jobs/{job_id}")
def get_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        return {
            "id": state["id"],
            "status": state["status"],
            "started_at": state["started_at"],
            "finished_at": state["finished_at"],
            "cancel_requested": state["cancel_requested"],
            "result": state["result"],
        }


@router.post("/api/scan/jobs/{job_id}/cancel")
def cancel_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        if state["status"] != "running":
            return {"id": job_id, "status": state["status"], "cancel_requested": state["cancel_requested"]}
        state["cancel_requested"] = True
        state["cancel_event"].set()
        _log_event(logging.WARNING, "scan.job.cancel_requested", correlation_id=job_id, job_id=job_id)
        return {"id": job_id, "status": state["status"], "cancel_requested": True}
