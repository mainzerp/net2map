"""Scan run history endpoint."""
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import ScanRun, get_db
from scan_engine import _safe_json_list
from schemas import ScanRunOut, ScanSwitchMetric

router = APIRouter()


@router.get("/api/scan-runs", response_model=List[ScanRunOut])
def list_scan_runs(limit: int = 20, db: Session = Depends(get_db)):
    clamped = max(1, min(200, limit))
    runs = db.query(ScanRun).order_by(ScanRun.created_at.desc()).limit(clamped).all()

    out: List[ScanRunOut] = []
    for idx, run in enumerate(runs):
        prev_run = runs[idx + 1] if idx + 1 < len(runs) else None
        current_devices = set(_safe_json_list(getattr(run, "devices_snapshot_json", "[]")))
        current_links = set(_safe_json_list(getattr(run, "links_snapshot_json", "[]")))
        prev_devices = set(_safe_json_list(getattr(prev_run, "devices_snapshot_json", "[]"))) if prev_run else set()
        prev_links = set(_safe_json_list(getattr(prev_run, "links_snapshot_json", "[]"))) if prev_run else set()

        new_devices = sorted(current_devices - prev_devices)
        removed_devices = sorted(prev_devices - current_devices)
        new_links = sorted(current_links - prev_links)
        removed_links = sorted(prev_links - current_links)

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
