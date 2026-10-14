"""FastAPI application entry point -- Net2Map backend."""
import base64
import hashlib
import logging
import re
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware

from config import rate_limit_storage_uri, validate_required_settings
from config import settings as app_settings
from database import create_tables
from routers import (
    audit,
    auth,
    bulk,
    config,
    credentials,
    endpoints,
    floors,
    health,
    latency,
    logs,
    map_bg,
    ping_candidates,
    rack_items,
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
from shared.api_version import (
    API_LEGACY_PREFIX,
    API_V1_PREFIX,
    LegacyApiDeprecationMiddleware,
    metrics_route_label,
)
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
        "Set CORS_ORIGIN to the specific frontend URL (e.g. https://net2map.example.com)"
    )

# Shared Redis storage when REDIS_URL is set so limits hold across uvicorn
# workers; in-memory otherwise (single process, tests). Router-level limiters
# pick up the same storage via RATELIMIT_STORAGE_URL (see config.py).
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=rate_limit_storage_uri(),
    in_memory_fallback_enabled=bool(app_settings.redis_url),
)


def _encrypt_legacy_plaintext_secrets() -> None:
    """Encrypt SNMP secrets stored in plaintext before ENCRYPTION_KEY was mandatory (idempotent)."""
    import database
    from shared.secrets import encrypt_plaintext_secrets

    db = database.SessionLocal()
    try:
        encrypt_plaintext_secrets(db)
    except Exception:
        db.rollback()
        _log.exception("Failed to encrypt plaintext SNMP secrets; they stay readable but unencrypted")
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    from shared.redis_client import get_redis
    from shared.state import migrate_legacy_redis_keys
    try:
        # JWT_SECRET, ENCRYPTION_KEY and a non-default admin password are mandatory.
        validate_required_settings()
    except RuntimeError as exc:
        _log.critical("%s", exc)
        raise
    if get_redis():
        _log.info("Starting backend with Redis state store (multi-worker capable)")
        migrate_legacy_redis_keys()
    else:
        _log.info("Starting single-worker backend (in-process state requires workers=1)")
    create_tables()
    _encrypt_legacy_plaintext_secrets()
    if not get_redis():
        threading.Thread(target=_background_scheduler, daemon=True).start()
    else:
        _log.info("Celery Beat scheduler available (Redis connected); skipping thread-based scheduler")
    yield
    # Shutdown cleanup
    from scan_engine.scheduler import shutdown_scheduler
    _log.info("Shutting down: signaling scheduler to stop")
    shutdown_scheduler()


# Docs routes are registered manually below (docs_url/redoc_url=None) so they
# can carry a docs-specific Content-Security-Policy.
app = FastAPI(
    title="Net2Map API",
    version="3.2.0",
    dependencies=[Depends(_require_auth)],
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/openapi.json" if app_settings.openapi_enabled else None,
)
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
        # Label with the route template (e.g. /api/v1/users/{user_id}) instead of
        # the raw path to bound Prometheus series cardinality. Legacy /api alias
        # templates are folded into their /api/v1 twin so both report one series.
        route = request.scope.get("route")
        template = getattr(route, "path", None)
        endpoint = metrics_route_label(request.scope["path"], template) if template else "unmatched"
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
app.add_middleware(LegacyApiDeprecationMiddleware)

# Unversioned infrastructure routes: GET /health and WebSocket /ws/scan-progress.
app.include_router(health.router)
app.include_router(ws.router)

# Routers whose paths are version-relative (e.g. "/devices").
API_ROUTERS = (
    settings.router,
    credentials.router,
    snmp_profiles.router,
    racks.router,
    rack_items.router,
    floors.router,
    switch_classes.router,
    switch_models.router,
    scan.router,
    scan_runs.router,
    topology.router,
    map_bg.router,
    scan_settings.router,
    bulk.router,
    config.router,
    logs.router,
    auth.router,
    audit.router,
    endpoints.router,
    latency.router,
    ping_candidates.router,
)

# Canonical v1 mount first: Starlette matches routes in registration order, so
# no legacy "/api/..." route can ever shadow an "/api/v1/..." route.
for _api_router in API_ROUTERS:
    app.include_router(_api_router, prefix=API_V1_PREFIX)
# Deprecated un-versioned alias, hidden from OpenAPI. Deprecation/Link headers
# are added by LegacyApiDeprecationMiddleware.
for _api_router in API_ROUTERS:
    app.include_router(_api_router, prefix=API_LEGACY_PREFIX, include_in_schema=False)


@app.get("/metrics", include_in_schema=False)
def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ---------------------------------------------------------------------------
# OpenAPI UI (Swagger UI at /docs, ReDoc at /redoc). FastAPI's HTML loads its
# assets from cdn.jsdelivr.net and contains an inline bootstrap script, which
# the strict SPA CSP in frontend/nginx.conf would block. These responses carry
# their own CSP that allows only those CDN origins plus the sha256 of the
# inline script; nginx does not add its SPA CSP on the docs paths. The pages
# are static; API calls made from them still require a bearer token.
# ---------------------------------------------------------------------------
_DOCS_CDN = "https://cdn.jsdelivr.net"
_INLINE_SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.DOTALL)


def _inline_script_hashes(html: str) -> list[str]:
    return [
        "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
        for body in _INLINE_SCRIPT_RE.findall(html)
    ]


def docs_csp(html: str) -> str:
    """Content-Security-Policy for a generated Swagger UI / ReDoc page."""
    script_src = " ".join([_DOCS_CDN, *_inline_script_hashes(html)])
    return (
        "default-src 'none'; "
        f"script-src {script_src}; "
        f"style-src 'unsafe-inline' {_DOCS_CDN} https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com data:; "
        f"img-src 'self' data: {_DOCS_CDN} https://fastapi.tiangolo.com; "
        "connect-src 'self'; "
        "worker-src blob:; "
        "frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    )


def _with_docs_csp(response: HTMLResponse) -> HTMLResponse:
    response.headers["Content-Security-Policy"] = docs_csp(response.body.decode())
    return response


async def swagger_ui(request):
    return _with_docs_csp(get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} - Swagger UI",
        # Disable the external validator badge (would load from validator.swagger.io).
        swagger_ui_parameters={"validatorUrl": None, "persistAuthorization": True},
    ))


async def redoc_ui(request):
    return _with_docs_csp(get_redoc_html(openapi_url=app.openapi_url, title=f"{app.title} - ReDoc"))


if app_settings.openapi_enabled:
    # add_route (not @app.get): plain Starlette routes skip the app-level auth
    # dependency, matching FastAPI's built-in /openapi.json route.
    app.add_route("/docs", swagger_ui, include_in_schema=False)
    app.add_route("/redoc", redoc_ui, include_in_schema=False)


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
