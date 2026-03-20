"""Audit trail helper for logging configuration changes."""
import logging

from fastapi import Request

_log = logging.getLogger(__name__)


def log_audit(request: Request, action: str, resource: str,
              resource_id: str = "", details: dict = None, db=None):
    """Record an audit log entry. Uses the provided db session if given,
    otherwise creates an independent session."""
    from database import AuditLog, SessionLocal

    user = getattr(request.state, "user", {})
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        db.add(AuditLog(
            user_id=user.get("id"),
            username=user.get("username", ""),
            action=action,
            resource=resource,
            resource_id=str(resource_id),
            details=details or {},
        ))
        if own_session:
            db.commit()
    except Exception:
        _log.exception("Failed to write audit log")
        if own_session:
            db.rollback()
    finally:
        if own_session:
            db.close()
