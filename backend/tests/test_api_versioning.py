"""Tests for API versioning: /api/v1 canonical mount and the deprecated /api alias."""
import re

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from starlette.routing import Match

from main import app
from shared.api_version import (
    API_LEGACY_PREFIX,
    API_V1_PREFIX,
    api_relative_path,
    canonical_api_path,
    metrics_route_label,
    successor_link,
)
from shared.metrics import REQUEST_TOTAL

_PARAM_RE = re.compile(r"\{[^}]+\}")


def _flat_routes():
    """All routes with their effective (prefixed) path, in matching order.

    FastAPI >= 0.13x includes routers lazily (app.routes holds included-router
    placeholders); iter_route_contexts flattens them into effective routes.
    """
    return list(iter_route_contexts(app.routes))


def _api_routes():
    return [r for r in _flat_routes() if isinstance(r.original_route, APIRoute)]


def _v1_routes():
    return [r for r in _api_routes() if r.path.startswith(API_V1_PREFIX + "/")]


def _legacy_routes():
    return [
        r for r in _api_routes()
        if r.path.startswith(API_LEGACY_PREFIX + "/") and not r.path.startswith(API_V1_PREFIX + "/")
    ]


# ---------------------------------------------------------------------------
# Route table
# ---------------------------------------------------------------------------

def test_every_legacy_route_has_v1_twin():
    v1 = {(r.path, frozenset(r.methods)) for r in _v1_routes()}
    legacy = _legacy_routes()
    assert legacy, "legacy alias mount is missing"
    for route in legacy:
        twin = (API_V1_PREFIX + route.path[len(API_LEGACY_PREFIX):], frozenset(route.methods))
        assert twin in v1, f"no v1 twin for {sorted(route.methods)} {route.path}"
    assert len(legacy) == len(v1)


def test_no_route_declares_literal_api_prefix_twice():
    for route in _api_routes():
        assert not route.path.startswith("/api/api"), route.path
        assert not route.path.startswith("/api/v1/api"), route.path


def test_infrastructure_routes_stay_unprefixed():
    # Websocket route contexts may not expose an effective path; health and ws
    # are included without a prefix, so the original path is authoritative.
    paths = {r.path or getattr(r.original_route, "path", None) for r in _flat_routes()}
    assert "/health" in paths
    assert "/metrics" in paths
    assert "/ws/scan-progress" in paths


def test_v1_paths_resolve_to_v1_routes():
    """No legacy route registered later may shadow a concrete /api/v1/... URL."""
    for route in _v1_routes():
        concrete = _PARAM_RE.sub("1", route.path)
        for method in route.methods:
            scope = {"type": "http", "path": concrete, "method": method, "root_path": ""}
            first_full = None
            for candidate in _flat_routes():
                match, _ = candidate.matches(scope)
                if match == Match.FULL:
                    first_full = candidate
                    break
            assert first_full is not None, f"{method} {concrete} unmatched"
            assert first_full.path.startswith(API_V1_PREFIX + "/"), (
                f"{method} {concrete} resolved to {first_full.path}"
            )


# ---------------------------------------------------------------------------
# OpenAPI
# ---------------------------------------------------------------------------

def test_openapi_lists_only_v1_paths_with_unique_operation_ids():
    app.openapi_schema = None
    schema = app.openapi()
    paths = schema["paths"]
    assert paths
    for path in paths:
        assert path.startswith(API_V1_PREFIX + "/") or path == "/health", path
    op_ids = [
        op["operationId"]
        for item in paths.values()
        for method, op in item.items()
        if isinstance(op, dict) and "operationId" in op
    ]
    assert len(op_ids) == len(set(op_ids))
    assert len(op_ids) == sum(len(r.methods) for r in _v1_routes() if r.include_in_schema)


# ---------------------------------------------------------------------------
# Real requests: parity and deprecation headers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", ["/devices", "/credentials", "/racks", "/settings", "/topology"])
def test_v1_and_legacy_return_same_response(client, auth_headers, path):
    v1 = client.get(API_V1_PREFIX + path, headers=auth_headers)
    legacy = client.get(API_LEGACY_PREFIX + path, headers=auth_headers)
    assert v1.status_code == legacy.status_code == 200
    assert v1.json() == legacy.json()


def test_legacy_response_carries_deprecation_headers(client, auth_headers):
    r = client.get("/api/devices?limit=5&q=a%20b", headers=auth_headers)
    assert r.status_code == 200
    assert r.headers["Deprecation"] == "true"
    assert r.headers["Link"] == '</api/v1/devices?limit=5&q=a%20b>; rel="successor-version"'


def test_legacy_response_without_query_string(client, auth_headers):
    r = client.get("/api/credentials", headers=auth_headers)
    assert r.headers["Link"] == '</api/v1/credentials>; rel="successor-version"'


def test_legacy_error_responses_carry_deprecation_headers(client, auth_headers):
    unauth = client.get("/api/credentials")
    assert unauth.status_code == 401
    assert unauth.headers["Deprecation"] == "true"
    missing = client.get("/api/racks/999999", headers=auth_headers)
    assert missing.headers["Deprecation"] == "true"
    assert missing.headers["Link"] == '</api/v1/racks/999999>; rel="successor-version"'


def test_v1_and_infrastructure_responses_have_no_deprecation_headers(client, auth_headers):
    for path in ("/api/v1/devices", "/api/v1/credentials", "/health"):
        r = client.get(path, headers=auth_headers)
        assert "Deprecation" not in r.headers, path
        assert "Link" not in r.headers, path


# ---------------------------------------------------------------------------
# Auth exemption is version-aware
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("prefix", [API_V1_PREFIX, API_LEGACY_PREFIX])
def test_login_is_auth_exempt_on_both_prefixes(client, prefix):
    r = client.post(prefix + "/auth/login", json={"username": "ghost", "password": "whatever1"})
    # Reaches the handler (invalid credentials) instead of failing AUTH_MISSING.
    assert r.status_code == 401
    assert "AUTH_MISSING" not in r.text


@pytest.mark.parametrize("prefix", [API_V1_PREFIX, API_LEGACY_PREFIX])
def test_map_background_is_auth_exempt_on_both_prefixes(client, prefix, tmp_path, monkeypatch):
    monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
    r = client.get(prefix + "/map-background")
    assert r.status_code == 404
    assert "NO_BACKGROUND_IMAGE" in r.text


@pytest.mark.parametrize("prefix", [API_V1_PREFIX, API_LEGACY_PREFIX])
def test_protected_route_requires_auth_on_both_prefixes(client, prefix):
    r = client.get(prefix + "/credentials")
    assert r.status_code == 401
    assert "AUTH_MISSING" in r.text


def test_unknown_version_prefix_is_not_auth_exempt():
    assert api_relative_path("/api/v2/auth/login") == "/v2/auth/login"
    assert api_relative_path("/api/api/v1/auth/login") == "/api/v1/auth/login"
    assert api_relative_path("/health") is None
    assert api_relative_path("/apiauth/login") is None


# ---------------------------------------------------------------------------
# Helpers and metrics
# ---------------------------------------------------------------------------

def test_metrics_route_label():
    # Lazy include (FastAPI >= 0.13x): template is prefix-less.
    assert metrics_route_label("/api/devices", "/devices") == "/api/v1/devices"
    assert metrics_route_label("/api/v1/devices", "/devices") == "/api/v1/devices"
    # Eager include (older FastAPI): template carries the mount prefix.
    assert metrics_route_label("/api/racks/1", "/api/racks/{rack_id}") == "/api/v1/racks/{rack_id}"
    assert metrics_route_label("/api/v1/racks/1", "/api/v1/racks/{rack_id}") == "/api/v1/racks/{rack_id}"
    assert metrics_route_label("/health", "/health") == "/health"


def test_canonical_api_path():
    assert canonical_api_path("/api/devices") == "/api/v1/devices"
    assert canonical_api_path("/api/users/{user_id}") == "/api/v1/users/{user_id}"
    assert canonical_api_path("/api/v1/devices") == "/api/v1/devices"
    assert canonical_api_path("/health") == "/health"
    assert canonical_api_path("/ws/scan-progress") == "/ws/scan-progress"


def test_successor_link_escapes_unsafe_characters():
    link = successor_link("/api/x y>", b"a=<b>")
    assert link == '</api/v1/x%20y%3E?a=%3Cb%3E>; rel="successor-version"'


def _endpoint_labels():
    labels = set()
    for metric in REQUEST_TOTAL.collect():
        for sample in metric.samples:
            if "endpoint" in sample.labels:
                labels.add(sample.labels["endpoint"])
    return labels


def test_metrics_fold_legacy_and_v1_into_one_series(client, auth_headers):
    client.get("/api/switch-classes", headers=auth_headers)
    client.get("/api/v1/switch-classes", headers=auth_headers)
    labels = _endpoint_labels()
    assert "/api/v1/switch-classes" in labels
    assert "/api/switch-classes" not in labels
