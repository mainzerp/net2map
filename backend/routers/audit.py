"""Audit log endpoint."""
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from config import settings
from database import AuditLog, get_db
from schemas import AuditLogOut
from shared.auth import require_role

router = APIRouter()


@router.get("/api/audit-logs", response_model=List[AuditLogOut],
            dependencies=[require_role("admin")])
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)):
    return db.query(AuditLog).order_by(
        AuditLog.timestamp.desc()
    ).limit(min(500, limit)).all()


@router.delete("/api/audit-logs/purge",
               dependencies=[require_role("admin")])
def purge_audit_logs(days: Optional[int] = None, db: Session = Depends(get_db)):
    retention = days if days is not None else settings.audit_retention_days
    if retention <= 0:
        return {"deleted": 0, "message": "Retention disabled"}
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention)
    deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
    db.commit()
    return {"deleted": deleted, "cutoff": cutoff.isoformat()}
