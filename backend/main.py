"""FastAPI application entry point -- NetMap backend."""
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

from database import create_tables, get_db
from scan_engine import _background_scheduler
from shared.auth import _require_auth
from shared.metrics import REQUEST_LATENCY, REQUEST_TOTAL

from routers import (
    health, settings, credentials, snmp_profiles, racks,
    switch_classes, switch_models, scan, scan_runs, topology,
    map_bg, scan_settings, bulk, config, logs, auth, audit, ws,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
_log = logging.getLogger(__name__)

CORS_ORIGIN = os.getenv("CORS_ORIGIN", "http://localhost:3000")
if CORS_ORIGIN == "*":
    _log.warning("CORS_ORIGIN is set to '*' -- this is insecure in production")

limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from shared.redis_client import get_redis
    if get_redis():
        _log.info("Starting backend with Redis state store (multi-worker capable)")
    else:
        _log.info("Starting single-worker backend (in-process state requires workers=1)")
    create_tables()
    threading.Thread(target=_background_scheduler, daemon=True).start()
    yield


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


app.add_middleware(MetricsMiddleware)

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
