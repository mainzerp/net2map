"""Audit log endpoint."""
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

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
