"""Tests for the health endpoint."""
from unittest.mock import MagicMock, patch


def test_health_returns_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"


def test_health_returns_checks_structure(client):
    """Health response includes checks dict with database key."""
    r = client.get("/health")
    data = r.json()
    assert "checks" in data
    assert "database" in data["checks"]


def test_health_degraded_when_redis_fails(client):
    """Health reports degraded when Redis ping fails."""
    mock_redis = MagicMock()
    mock_redis.ping.side_effect = ConnectionError("refused")

    with patch("routers.health.get_redis", return_value=mock_redis):
        r = client.get("/health")
        data = r.json()
        assert data["checks"]["redis"] == "error"
        assert data["status"] == "degraded"


def test_health_redis_not_configured(client, auth_headers):
    """Health reports redis as not_configured when get_redis returns None."""
    with patch("routers.health.get_redis", return_value=None):
        r = client.get("/health")
        data = r.json()
        assert data["checks"]["redis"] == "not_configured"
        assert "celery" not in data["checks"]

        r = client.get("/health?deep=1", headers=auth_headers)
        data = r.json()
        assert r.status_code == 200
        assert data["checks"]["celery"] == "not_configured"
        assert data["workers"] == "not_configured"


def _healthy_redis():
    mock_redis = MagicMock()
    mock_redis.ping.return_value = True
    return mock_redis


def test_health_liveness_ignores_missing_celery_worker(client):
    """Liveness (container healthcheck) stays 200 without a Celery worker."""
    mock_celery = MagicMock()
    mock_celery.control.ping.return_value = []
    with patch("routers.health.get_redis", return_value=_healthy_redis()), \
         patch("celery_app.celery_app", mock_celery):
        r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert data["checks"]["redis"] == "ok"
    assert "workers" not in data
    mock_celery.control.ping.assert_not_called()


def test_health_deep_reports_no_workers_as_503(client, auth_headers):
    mock_celery = MagicMock()
    mock_celery.control.ping.return_value = []
    with patch("routers.health.get_redis", return_value=_healthy_redis()), \
         patch("celery_app.celery_app", mock_celery):
        r = client.get("/health?deep=1", headers=auth_headers)
    assert r.status_code == 503
    data = r.json()
    assert data["status"] == "degraded"
    assert data["workers"] == "none"
    assert data["checks"]["celery"] == "none"


def test_health_deep_ok_with_worker(client, auth_headers):
    mock_celery = MagicMock()
    mock_celery.control.ping.return_value = [{"celery@worker": {"ok": "pong"}}]
    with patch("routers.health.get_redis", return_value=_healthy_redis()), \
         patch("celery_app.celery_app", mock_celery):
        r = client.get("/health?deep=1", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["workers"] == "ok"


def test_health_deep_reports_unreachable_broker(client, auth_headers):
    mock_celery = MagicMock()
    mock_celery.control.ping.side_effect = OSError("broker down")
    with patch("routers.health.get_redis", return_value=_healthy_redis()), \
         patch("celery_app.celery_app", mock_celery):
        r = client.get("/health?deep=1", headers=auth_headers)
    assert r.status_code == 503
    assert r.json()["workers"] == "unreachable"


def test_health_returns_503_when_redis_fails(client):
    mock_redis = MagicMock()
    mock_redis.ping.side_effect = ConnectionError("refused")
    with patch("routers.health.get_redis", return_value=mock_redis):
        r = client.get("/health")
    assert r.status_code == 503


class TestOpenApiDocs:
    def test_docs_served_without_auth_with_docs_csp(self, client):
        r = client.get("/docs")
        assert r.status_code == 200
        csp = r.headers["content-security-policy"]
        assert "https://cdn.jsdelivr.net" in csp
        assert "'sha256-" in csp
        assert "'unsafe-inline'" not in csp.split("script-src", 1)[1].split(";", 1)[0]

    def test_inline_script_hash_matches(self):
        import base64
        import hashlib

        from main import docs_csp
        html = "<html><script>const a = 1;</script></html>"
        digest = base64.b64encode(hashlib.sha256(b"const a = 1;").digest()).decode()
        assert f"'sha256-{digest}'" in docs_csp(html)

    def test_redoc_and_schema_served(self, client):
        assert client.get("/redoc").status_code == 200
        r = client.get("/openapi.json")
        assert r.status_code == 200
        assert any(p.startswith("/api/v1/") for p in r.json()["paths"])


class TestRateLimitStorage:
    def test_memory_without_redis(self):
        from config import rate_limit_storage_uri
        assert rate_limit_storage_uri("") == "memory://"

    def test_redis_when_configured(self):
        from config import rate_limit_storage_uri
        assert rate_limit_storage_uri("redis://redis:6379/0") == "redis://redis:6379/0"

    def test_test_suite_uses_memory_storage(self):
        from limits.storage import MemoryStorage

        from main import limiter
        assert isinstance(limiter._storage, MemoryStorage)


class TestRequestLogging:
    def test_request_logging_middleware_class_exists(self):
        from main import RequestLoggingMiddleware
        assert RequestLoggingMiddleware is not None

    def test_skip_log_paths_defined(self):
        from main import _SKIP_LOG_PATHS
        assert "/health" in _SKIP_LOG_PATHS
        assert "/metrics" in _SKIP_LOG_PATHS
        assert "/ws" in _SKIP_LOG_PATHS


def test_health_never_returns_exception_text(client):
    """Component errors are logged; the response only says "error"."""
    mock_redis = MagicMock()
    mock_redis.ping.side_effect = ConnectionError("secret-host:6379 refused")
    with patch("routers.health.get_redis", return_value=mock_redis), \
         patch("routers.health.SessionLocal", side_effect=RuntimeError("password=hunter2")):
        r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["checks"] == {"database": "error", "redis": "error"}
    assert "hunter2" not in r.text and "secret-host" not in r.text


def test_health_deep_requires_authentication(client):
    with patch("routers.health.get_redis", return_value=None):
        assert client.get("/health").status_code == 200
        r = client.get("/health?deep=1")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_REQUIRED"
