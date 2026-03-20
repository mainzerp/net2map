"""Health check endpoint with component status verification."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from database import SessionLocal
from shared.redis_client import get_redis

router = APIRouter()


@router.get("/health", include_in_schema=False)
def health():
    checks = {}
    overall = "ok"

    # Database connectivity
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            checks["database"] = "ok"
        finally:
            db.close()
    except Exception as e:
        checks["database"] = f"error: {e}"
        overall = "degraded"

    # Redis connectivity
    r = get_redis()
    if r:
        try:
            r.ping()
            checks["redis"] = "ok"
        except Exception as e:
            checks["redis"] = f"error: {e}"
            overall = "degraded"
    else:
        checks["redis"] = "not_configured"

    # Celery worker availability (only if Redis is available)
    if r:
        try:
            from celery_app import celery_app
            result = celery_app.control.ping(timeout=2)
            checks["celery"] = "ok" if result else "no_workers"
            if not result:
                overall = "degraded"
        except Exception:
            checks["celery"] = "unreachable"
            overall = "degraded"
    else:
        checks["celery"] = "not_configured"

    return JSONResponse(
        content={"status": overall, "checks": checks},
        status_code=200 if overall == "ok" else 503,
    )
