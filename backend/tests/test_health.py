"""Tests for the health endpoint."""
from unittest.mock import patch, MagicMock


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
        assert data["checks"]["redis"].startswith("error")
        assert data["status"] == "degraded"


def test_health_redis_not_configured(client):
    """Health reports redis as not_configured when get_redis returns None."""
    with patch("routers.health.get_redis", return_value=None):
        r = client.get("/health")
        data = r.json()
        assert data["checks"]["redis"] == "not_configured"
        assert data["checks"]["celery"] == "not_configured"


class TestRequestLogging:
    def test_request_logging_middleware_class_exists(self):
        from main import RequestLoggingMiddleware
        assert RequestLoggingMiddleware is not None

    def test_skip_log_paths_defined(self):
        from main import _SKIP_LOG_PATHS
        assert "/health" in _SKIP_LOG_PATHS
        assert "/metrics" in _SKIP_LOG_PATHS
        assert "/ws" in _SKIP_LOG_PATHS
