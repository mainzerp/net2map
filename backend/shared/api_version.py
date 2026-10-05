"""API versioning: URL prefixes, path helpers and the legacy-alias deprecation middleware.

Routers declare version-less paths (e.g. "/devices"). main.py mounts every API
router twice:

* ``API_V1_PREFIX`` ("/api/v1") -- canonical, documented in OpenAPI.
* ``API_LEGACY_PREFIX`` ("/api") -- deprecated alias kept for backward
  compatibility, hidden from OpenAPI. Responses served through it carry
  ``Deprecation: true`` and a ``Link: <...>; rel="successor-version"`` header
  pointing at the canonical URL (see ``LegacyApiDeprecationMiddleware``).

To add a future version, add its prefix to ``VERSIONED_API_PREFIXES`` and mount
the routers under it in main.py.
"""
import logging
from urllib.parse import quote

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_log = logging.getLogger(__name__)

API_V1_PREFIX = "/api/v1"
API_LEGACY_PREFIX = "/api"

# Versioned prefixes, newest first. The legacy prefix is handled separately
# because it is a prefix of every versioned one.
VERSIONED_API_PREFIXES: tuple[str, ...] = (API_V1_PREFIX,)

# Characters left unescaped when re-encoding a decoded path / query string for
# the Link header. Excludes "<", ">", spaces and control characters so the
# header value cannot break out of the URI-reference brackets.
_PATH_SAFE = "/-._~!$&'()*+,;=:@"
_QUERY_SAFE = _PATH_SAFE + "?%"


def _strip_prefix(path: str, prefix: str) -> str | None:
    if path == prefix:
        return "/"
    if path.startswith(prefix + "/"):
        return path[len(prefix):]
    return None


def split_api_path(path: str) -> tuple[str | None, str]:
    """Split a request path into (mount prefix, API-relative path).

    Returns ``(None, path)`` for non-API paths such as "/health" or "/ws/...".
    Examples: "/api/v1/devices" -> ("/api/v1", "/devices");
    "/api/devices" -> ("/api", "/devices").
    """
    for prefix in VERSIONED_API_PREFIXES:
        rest = _strip_prefix(path, prefix)
        if rest is not None:
            return prefix, rest
    rest = _strip_prefix(path, API_LEGACY_PREFIX)
    if rest is not None:
        return API_LEGACY_PREFIX, rest
    return None, path


def api_relative_path(path: str) -> str | None:
    """Return the version-independent part of an API path, or None for non-API paths."""
    prefix, rest = split_api_path(path)
    return rest if prefix is not None else None


def is_legacy_api_path(path: str) -> bool:
    """True if the path is served through the deprecated un-versioned /api alias."""
    return split_api_path(path)[0] == API_LEGACY_PREFIX


def canonical_api_path(path: str) -> str:
    """Map a legacy "/api/..." path or route template onto its "/api/v1/..." form.

    Versioned and non-API paths are returned unchanged.
    """
    prefix, rest = split_api_path(path)
    if prefix == API_LEGACY_PREFIX:
        return API_V1_PREFIX + rest
    return path


def metrics_route_label(request_path: str, route_template: str) -> str:
    """Return a Prometheus endpoint label that is identical for /api/v1/x and /api/x.

    Since FastAPI 0.13x ``include_router`` is lazy and ``scope["route"]`` is the
    original, prefix-less route ("/devices"); older versions expose the full
    template ("/api/devices"). Both forms are handled: the version comes from
    the request path, the legacy alias is folded into /api/v1.
    """
    prefix, _ = split_api_path(request_path)
    if prefix is None:
        return route_template
    version_prefix = API_V1_PREFIX if prefix == API_LEGACY_PREFIX else prefix
    template_prefix, template_rest = split_api_path(route_template)
    if template_prefix is not None:
        return version_prefix + template_rest
    return version_prefix + route_template


def successor_link(path: str, query_string: bytes = b"") -> str:
    """Build the Link header value pointing a legacy request at its v1 successor."""
    target = quote(canonical_api_path(path), safe=_PATH_SAFE)
    if query_string:
        target += "?" + quote(query_string.decode("latin-1"), safe=_QUERY_SAFE)
    return f'<{target}>; rel="successor-version"'


class LegacyApiDeprecationMiddleware:
    """Add deprecation headers to every HTTP response served via the legacy /api alias.

    Pure ASGI middleware keyed on the request path, so it also decorates error
    responses produced by exception handlers (401, 403, 404, 422, ...). Only
    unhandled exceptions that escape to Starlette's outermost
    ServerErrorMiddleware (plain 500) bypass it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not is_legacy_api_path(scope["path"]):
            await self.app(scope, receive, send)
            return

        link = successor_link(scope["path"], scope.get("query_string", b""))
        _log.debug("legacy API path used path=%s successor=%s", scope["path"], link)

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Deprecation"] = "true"
                headers.append("Link", link)
            await send(message)

        await self.app(scope, receive, send_with_headers)
