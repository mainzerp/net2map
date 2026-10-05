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


def get_audit_retention_days(db) -> int:
    """Effective audit retention in days.

    Precedence: the ``audit_retention_days`` app setting (DB, editable via
    PUT /api/v1/settings/audit_retention_days) when it is a positive integer,
    else the AUDIT_RETENTION_DAYS env var / config default (90). Invalid DB
    values are logged and ignored. A result ``<= 0`` (only possible from the env
    var) disables the scheduled purge.
    """
    from config import settings
    from database import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == "audit_retention_days").first()
    if row is not None and row.value is not None:
        try:
            days = int(str(row.value).strip())
        except ValueError:
            days = 0
        if days > 0:
            return days
        _log.warning("Ignoring invalid audit_retention_days setting %r; using AUDIT_RETENTION_DAYS=%s",
                     row.value, settings.audit_retention_days)
    return settings.audit_retention_days
