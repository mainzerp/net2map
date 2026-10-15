"""CRUD and manual scan endpoints for discovery scan ranges."""
from typing import Iterable, List

from fastapi import APIRouter, Depends, Request, Response
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import ScanRange, SnmpProfile, get_db
from scan_engine import _start_job
from schemas import ScanRangeCreate, ScanRangeOut, ScanRangeUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.scan_ranges import (
    ScanRangeError,
    clean_profile_ids,
    normalize_scan_range,
    range_next_scan_at,
    read_global_discovery_interval,
    scan_range_host_count,
)

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


def scan_range_out(row: ScanRange, global_interval: int) -> dict:
    """Serialize a ScanRange row into the ScanRangeOut shape."""
    return {
        "id": row.id,
        "cidr": row.cidr,
        "label": row.label or "",
        "enabled": bool(row.enabled),
        "interval_sec": row.interval_sec,
        "profile_ids": clean_profile_ids(row.profile_ids),
        "last_scan_at": row.last_scan_at,
        "next_scan_at": range_next_scan_at(row, global_interval),
        "host_count": scan_range_host_count(row.cidr),
    }


def _normalize_cidr_or_error(value: str) -> str:
    try:
        return normalize_scan_range(value)
    except ScanRangeError as exc:
        api_error(400, exc.code, str(exc), field="cidr")


def _validate_profile_ids(db: Session, profile_ids: Iterable[int]) -> List[int]:
    ids = list(dict.fromkeys(int(p) for p in profile_ids))
    if not ids:
        return []
    known = {row[0] for row in db.query(SnmpProfile.id).filter(SnmpProfile.id.in_(ids)).all()}
    missing = [p for p in ids if p not in known]
    if missing:
        api_error(400, "UNKNOWN_PROFILE", f"Unknown SNMP profile id(s): {missing}", field="profile_ids")
    return ids


def _get_range_or_404(db: Session, range_id: int) -> ScanRange:
    row = db.query(ScanRange).filter(ScanRange.id == range_id).first()
    if row is None:
        api_error(404, "SCAN_RANGE_NOT_FOUND", "Scan range not found")
    return row


def _ensure_unique(db: Session, cidr: str, exclude_id: int | None = None) -> None:
    query = db.query(ScanRange.id).filter(ScanRange.cidr == cidr)
    if exclude_id is not None:
        query = query.filter(ScanRange.id != exclude_id)
    if query.first() is not None:
        api_error(409, "RANGE_EXISTS", f"Scan range {cidr} already exists", field="cidr")


def _commit_or_conflict(db: Session, cidr: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        api_error(409, "RANGE_EXISTS", f"Scan range {cidr} already exists", field="cidr")


@router.get("/scan-ranges", response_model=List[ScanRangeOut])
def list_scan_ranges(db: Session = Depends(get_db)):
    """Return all scan ranges ordered by CIDR."""
    global_interval = read_global_discovery_interval(db)
    return [scan_range_out(r, global_interval) for r in db.query(ScanRange).order_by(ScanRange.cidr).all()]


@router.post("/scan-ranges", response_model=ScanRangeOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_scan_range(body: ScanRangeCreate, request: Request, db: Session = Depends(get_db)):
    cidr = _normalize_cidr_or_error(body.cidr)
    _ensure_unique(db, cidr)
    profile_ids = _validate_profile_ids(db, body.profile_ids)
    row = ScanRange(
        cidr=cidr,
        label=body.label.strip(),
        enabled=body.enabled,
        interval_sec=body.interval_sec,
        profile_ids=profile_ids,
    )
    db.add(row)
    _commit_or_conflict(db, cidr)
    db.refresh(row)
    log_audit(request, "create", "scan_range", str(row.id), {
        "cidr": row.cidr, "label": row.label, "enabled": row.enabled,
        "interval_sec": row.interval_sec, "profile_ids": profile_ids,
    })
    return scan_range_out(row, read_global_discovery_interval(db))


@router.post("/scan-ranges/scan", dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
def scan_all_ranges(request: Request):
    """Start a scan of all enabled ranges (ignores their schedule)."""
    result = _start_job(dry_run=False, scan_type="ranges_all")
    log_audit(request, "scan", "scan_range", "", {"mode": "ranges_all", "job_id": result.get("job_id", "")})
    return result


@router.patch("/scan-ranges/{range_id}", response_model=ScanRangeOut,
              dependencies=[require_role("admin", "operator")])
def update_scan_range(range_id: int, body: ScanRangeUpdate, request: Request, db: Session = Depends(get_db)):
    row = _get_range_or_404(db, range_id)
    fields = body.model_fields_set
    changes: dict = {}
    if "cidr" in fields and body.cidr is not None:
        cidr = _normalize_cidr_or_error(body.cidr)
        if cidr != row.cidr:
            _ensure_unique(db, cidr, exclude_id=row.id)
            row.cidr = cidr
            changes["cidr"] = cidr
    if "label" in fields and body.label is not None:
        row.label = body.label.strip()
        changes["label"] = row.label
    if "enabled" in fields and body.enabled is not None:
        row.enabled = body.enabled
        changes["enabled"] = row.enabled
    if "interval_sec" in fields:
        # An explicit null resets the range to the global discovery interval.
        row.interval_sec = body.interval_sec
        changes["interval_sec"] = row.interval_sec
    if "profile_ids" in fields:
        row.profile_ids = _validate_profile_ids(db, body.profile_ids or [])
        changes["profile_ids"] = row.profile_ids
    _commit_or_conflict(db, row.cidr)
    db.refresh(row)
    log_audit(request, "update", "scan_range", str(row.id), changes)
    return scan_range_out(row, read_global_discovery_interval(db))


@router.delete("/scan-ranges/{range_id}", status_code=204,
               dependencies=[require_role("admin", "operator")])
def delete_scan_range(range_id: int, request: Request, db: Session = Depends(get_db)):
    row = _get_range_or_404(db, range_id)
    cidr = row.cidr
    db.delete(row)
    db.commit()
    log_audit(request, "delete", "scan_range", str(range_id), {"cidr": cidr})
    return Response(status_code=204)


@router.post("/scan-ranges/{range_id}/scan", dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
def scan_one_range(range_id: int, request: Request, db: Session = Depends(get_db)):
    """Mark one range as due and start a scheduled-style range scan."""
    row = _get_range_or_404(db, range_id)
    row.last_scan_at = None
    db.commit()
    result = _start_job(dry_run=False, scan_type="ranges")
    log_audit(request, "scan", "scan_range", str(range_id), {
        "mode": "ranges", "cidr": row.cidr, "job_id": result.get("job_id", ""),
    })
    return result
