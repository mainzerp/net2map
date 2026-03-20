"""Tests for the centralized config module (config.py Settings class)."""
import os


def test_settings_reads_env_vars(monkeypatch):
    """Settings picks up environment variables."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://testhost/testdb")
    monkeypatch.setenv("REDIS_URL", "redis://redis-test:6379/1")
    monkeypatch.setenv("CORS_ORIGIN", "http://myapp.local")
    monkeypatch.setenv("JWT_SECRET", "supersecret")
    monkeypatch.setenv("JWT_EXPIRY_HOURS", "48")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    # Re-import to pick up new env vars
    from config import Settings
    s = Settings()

    assert s.database_url == "postgresql://testhost/testdb"
    assert s.redis_url == "redis://redis-test:6379/1"
    assert s.cors_origin == "http://myapp.local"
    assert s.jwt_secret == "supersecret"
    assert s.jwt_expiry_hours == 48
    assert s.log_level == "DEBUG"


def test_settings_defaults():
    """Settings has sensible defaults when env vars are not set."""
    from config import Settings

    # Construct with explicit overrides cleared
    s = Settings(
        database_url="postgresql://netmap:netmap_pw@postgres/netmap",
        redis_url="",
        cors_origin="http://localhost:3000",
        jwt_secret="",
        jwt_expiry_hours=24,
        log_level="INFO",
    )
    assert s.database_url == "postgresql://netmap:netmap_pw@postgres/netmap"
    assert s.redis_url == ""
    assert s.cors_origin == "http://localhost:3000"
    assert s.jwt_expiry_hours == 24
    assert s.log_level == "INFO"


def test_settings_singleton_available():
    """The module-level `settings` instance is importable."""
    from config import settings
    assert hasattr(settings, "database_url")
    assert hasattr(settings, "redis_url")
    assert hasattr(settings, "jwt_secret")
