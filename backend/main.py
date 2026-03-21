"""FastAPI application entry point -- NetMap backend."""
import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware

from config import settings as app_settings
from database import create_tables
from routers import (
    audit,
    auth,
    bulk,
    config,
    credentials,
    endpoints,
    health,
    logs,
    map_bg,
    racks,
    scan,
    scan_runs,
    scan_settings,
    settings,
    snmp_profiles,
    switch_classes,
    switch_models,
    topology,
    ws,
)
from scan_engine import _background_scheduler
from shared.auth import _require_auth
from shared.metrics import REQUEST_LATENCY, REQUEST_TOTAL

logging.basicConfig(
    level=getattr(logging, app_settings.log_level.upper(), logging.INFO),
    format="%(levelname)s %(name)s: %(message)s",
)
_log = logging.getLogger(__name__)

CORS_ORIGIN = app_settings.cors_origin
if CORS_ORIGIN == "*":
    _log.warning(
        "CORS_ORIGIN is set to '*' -- this is insecure in production. "
        "Set CORS_ORIGIN to the specific frontend URL (e.g. https://netmap.example.com)"
    )

limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from shared.redis_client import get_redis
    if get_redis():
        _log.info("Starting backend with Redis state store (multi-worker capable)")
    else:
        _log.info("Starting single-worker backend (in-process state requires workers=1)")
    create_tables()
    if not app_settings.jwt_secret and not app_settings.secret_token:
        _log.critical(
            "SECURITY: No authentication configured (JWT_SECRET and SECRET_TOKEN are both unset). "
            "All API endpoints are accessible without authentication. "
            "Set JWT_SECRET or SECRET_TOKEN before deploying to production."
        )
    if not app_settings.encryption_key:
        _log.critical(
            "SECURITY: ENCRYPTION_KEY is not set. SNMP passwords will be stored in PLAINTEXT. "
            'Generate a key with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
        )
    if not get_redis():
        threading.Thread(target=_background_scheduler, daemon=True).start()
    else:
        _log.info("Celery Beat scheduler available (Redis connected); skipping thread-based scheduler")
    yield
    # Shutdown cleanup
    from scan_engine.scheduler import shutdown_scheduler
    _log.info("Shutting down: signaling scheduler to stop")
    shutdown_scheduler()


app = FastAPI(title="NetMap API", version="1.0.0", dependencies=[Depends(_require_auth)], lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path == "/metrics":
            return await call_next(request)
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start
        endpoint = request.url.path
        REQUEST_LATENCY.labels(method=request.method, endpoint=endpoint).observe(duration)
        REQUEST_TOTAL.labels(method=request.method, endpoint=endpoint, status=response.status_code).inc()
        return response


_SKIP_LOG_PATHS = {"/health", "/metrics", "/ws"}


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path in _SKIP_LOG_PATHS or request.url.path.startswith("/ws"):
            return await call_next(request)
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        _log.info(
            "request method=%s path=%s status=%d duration_ms=%.1f",
            request.method, request.url.path, response.status_code, duration_ms,
        )
        return response


app.add_middleware(MetricsMiddleware)
if app_settings.request_log_enabled:
    app.add_middleware(RequestLoggingMiddleware)

app.include_router(health.router)
app.include_router(settings.router)
app.include_router(credentials.router)
app.include_router(snmp_profiles.router)
app.include_router(racks.router)
app.include_router(switch_classes.router)
app.include_router(switch_models.router)
app.include_router(scan.router)
app.include_router(scan_runs.router)
app.include_router(topology.router)
app.include_router(map_bg.router)
app.include_router(scan_settings.router)
app.include_router(bulk.router)
app.include_router(config.router)
app.include_router(logs.router)
app.include_router(auth.router)
app.include_router(audit.router)
app.include_router(ws.router)
app.include_router(endpoints.router)


@app.get("/metrics", include_in_schema=False)
def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    _log.exception("Unhandled error")
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    detail = exc.detail
    if isinstance(detail, dict) and "error" in detail:
        return JSONResponse(status_code=exc.status_code, content=detail, headers=getattr(exc, "headers", None))
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "HTTP_ERROR", "message": str(detail)}},
        headers=getattr(exc, "headers", None),
    )
