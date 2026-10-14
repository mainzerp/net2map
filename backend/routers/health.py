"""Health check endpoint with component status verification.

Contract (``GET /health``, unversioned, auth-exempt):
- Default (liveness): database and Redis only. ``200`` when both are OK (Redis
  may be ``not_configured``), ``503`` otherwise. This is the container
  healthcheck, so it must not depend on Celery: a missing worker must not mark
  the backend unhealthy and block dependent containers.
- ``?deep=1`` (readiness): additionally pings the Celery workers (up to 2 s)
  and reports the result as ``workers`` (``ok`` | ``none`` | ``unreachable`` |
  ``not_configured``) and ``checks.celery``. ``503`` when no worker answers
  while Redis is configured. Requires a valid bearer token (any role); the
  path stays auth-exempt for liveness, so the token is checked here (401
  otherwise).
- Failed checks report ``"error"`` only; the exception is logged, never
  returned.
"""
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from database import SessionLocal
from shared.errors import api_error
from shared.redis_client import get_redis

_log = logging.getLogger(__name__)

router = APIRouter()


def _worker_status(redis_client) -> str:
    """Ping Celery workers: ok | none | unreachable | not_configured."""
    if not redis_client:
        return "not_configured"
    try:
        from celery_app import celery_app
        result = celery_app.control.ping(timeout=2)
        return "ok" if result else "none"
    except Exception:
        return "unreachable"


@router.get("/health", include_in_schema=False)
def health(request: Request, deep: bool = False):
    if deep and not getattr(request.state, "user", None):
        api_error(401, "AUTH_REQUIRED", "Authentication required for deep health checks")
    checks = {}
    healthy = True

    # Database connectivity
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            checks["database"] = "ok"
        finally:
            db.close()
    except Exception:
        _log.exception("Health check: database unavailable")
        checks["database"] = "error"
        healthy = False

    # Redis connectivity
    r = get_redis()
    if r:
        try:
            r.ping()
            checks["redis"] = "ok"
        except Exception:
            _log.exception("Health check: Redis unavailable")
            checks["redis"] = "error"
            healthy = False
    else:
        checks["redis"] = "not_configured"

    content = {"checks": checks}
    # Celery worker availability: readiness only, never part of liveness.
    if deep:
        workers = _worker_status(r)
        checks["celery"] = workers
        content["workers"] = workers
        if workers not in ("ok", "not_configured"):
            healthy = False

    content = {"status": "ok" if healthy else "degraded", **content}
    return JSONResponse(content=content, status_code=200 if healthy else 503)
