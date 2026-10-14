"""Audit trail helper for logging configuration changes."""
import logging

from fastapi import Request

_log = logging.getLogger(__name__)


def log_audit(request: Request, action: str, resource: str,
              resource_id: str = "", details: dict = None, db=None, strict: bool = False):
    """Record an audit log entry. Uses the provided db session if given,
    otherwise creates an independent session.

    Lenient (default): failures are logged and swallowed.

    ``strict=True`` is for security-critical changes (users, credentials,
    SNMP profiles, config/bulk imports): the entry is added to the caller's
    session ``db`` (required) WITHOUT committing, so it is persisted by the
    caller's commit in the same transaction as the change itself. Any failure
    propagates: the request fails with 500 and the change is rolled back
    together with the audit record. Call it before ``db.commit()``.
    """
    from database import AuditLog, SessionLocal

    user = getattr(request.state, "user", None) or {}
    if strict:
        if db is None:
            raise ValueError("log_audit(strict=True) requires the caller's db session")
        db.add(AuditLog(
            user_id=user.get("id"),
            username=user.get("username", ""),
            action=action,
            resource=resource,
            resource_id=str(resource_id),
            details=details or {},
        ))
        return
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
