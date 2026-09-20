"""Scan run history endpoint."""
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, selectinload

from database import DryRunResult, ScanRun, get_db
from scan_engine import _safe_json_list
from schemas import ScanRunOut, ScanSwitchMetric
from shared.errors import api_error

router = APIRouter()


@router.get("/api/scan-runs", response_model=List[ScanRunOut])
def list_scan_runs(limit: int = 20, db: Session = Depends(get_db)):
    clamped = max(1, min(200, limit))
    # Fetch one extra run so the oldest run in the window can be diffed
    # against a real predecessor instead of an empty snapshot.
    runs = (
        db.query(ScanRun)
        .options(selectinload(ScanRun.switch_metrics))
        .order_by(ScanRun.created_at.desc())
        .limit(clamped + 1)
        .all()
    )

    out: List[ScanRunOut] = []
    for idx, run in enumerate(runs[:clamped]):
        prev_run = runs[idx + 1] if idx + 1 < len(runs) else None
        current_devices = set(_safe_json_list(getattr(run, "devices_snapshot_json", "[]")))
        current_links = set(_safe_json_list(getattr(run, "links_snapshot_json", "[]")))

        if prev_run:
            prev_devices = set(_safe_json_list(getattr(prev_run, "devices_snapshot_json", "[]")))
            prev_links = set(_safe_json_list(getattr(prev_run, "links_snapshot_json", "[]")))
            new_devices = sorted(current_devices - prev_devices)
            removed_devices = sorted(prev_devices - current_devices)
            new_links = sorted(current_links - prev_links)
            removed_links = sorted(prev_links - current_links)
        else:
            # No predecessor exists; leave the diff empty rather than
            # reporting every device/link as new.
            new_devices = []
            removed_devices = []
            new_links = []
            removed_links = []

        metrics = [
            ScanSwitchMetric(
                ip=m.ip,
                label=m.label,
                duration_ms=m.duration_ms,
                success=bool(m.success),
                error=m.error or "",
            )
            for m in run.switch_metrics
        ]
        out.append(ScanRunOut(
            id=run.id,
            status=run.status,
            scanned=run.scanned,
            found=run.found,
            links=run.links,
            max_workers=run.max_workers,
            total_duration_ms=run.total_duration_ms,
            error_count=run.error_count,
            new_devices=new_devices,
            removed_devices=removed_devices,
            new_links=new_links,
            removed_links=removed_links,
            created_at=run.created_at,
            switch_metrics=metrics,
        ))
    return out


@router.get("/api/scan-runs/{run_id}/dry-run-preview")
def get_dry_run_preview(run_id: int, db: Session = Depends(get_db)):
    record = db.query(DryRunResult).filter(DryRunResult.scan_run_id == run_id).first()
    if not record:
        api_error(404, "DRY_RUN_NOT_FOUND", "Dry-run preview not found")
    return record.preview_json
