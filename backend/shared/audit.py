"""Audit trail helper for logging configuration changes."""
import logging

from fastapi import Request

_log = logging.getLogger(__name__)


def log_audit(request: Request, action: str, resource: str,
              resource_id: str = "", details: dict = None):
    """Record an audit log entry with the current user context."""
    from database import AuditLog, SessionLocal

    user = getattr(request.state, "user", {})
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
        db.commit()
    except Exception:
        _log.exception("Failed to write audit log")
        db.rollback()
    finally:
        db.close()
