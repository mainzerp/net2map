"""Audit log endpoint."""
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from config import settings
from database import AuditLog, get_db
from schemas import AuditLogOut
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


@router.get("/audit-logs", response_model=List[AuditLogOut],
            dependencies=[require_role("admin")])
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)):
    if limit < 1 or limit > 500:
        api_error(400, "INVALID_LIMIT", "limit must be between 1 and 500", field="limit")
    return db.query(AuditLog).order_by(
        AuditLog.timestamp.desc()
    ).limit(limit).all()


@router.delete("/audit-logs/purge",
               dependencies=[require_role("admin")])
def purge_audit_logs(days: Optional[int] = None, db: Session = Depends(get_db)):
    retention = days if days is not None else settings.audit_retention_days
    if retention <= 0:
        api_error(400, "INVALID_RETENTION", "days must be a positive integer", field="days")
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention)
    deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
    db.commit()
    return {"deleted": deleted, "cutoff": cutoff.isoformat()}
