"""Centralized configuration via Pydantic BaseSettings."""
import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://netmap:netmap_pw@postgres/netmap"

    # Redis / Celery
    redis_url: str = ""

    # CORS
    cors_origin: str = "http://localhost:3000"

    # Authentication
    jwt_secret: str = ""
    secret_token: str = ""  # legacy single-token auth
    jwt_expiry_hours: int = 24
    encryption_key: str = ""

    # Seed data
    default_admin_password: str = "changeme"

    # Logging
    log_level: str = "INFO"

    # Audit
    audit_retention_days: int = 90

    # Request logging
    request_log_enabled: bool = False

    # API documentation: Swagger UI (/docs), ReDoc (/redoc), schema (/openapi.json)
    openapi_enabled: bool = True

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()


def rate_limit_storage_uri(redis_url: str | None = None) -> str:
    """Return the slowapi/limits storage URI: shared Redis when configured, else in-memory."""
    url = settings.redis_url if redis_url is None else redis_url
    return url or "memory://"


# Every router module builds its own slowapi Limiter; slowapi reads
# RATELIMIT_STORAGE_URL from the environment when no storage_uri is passed.
# Exporting it here (config is imported before any router) makes all limiters
# count in Redis, i.e. across uvicorn workers. The in-memory fallback keeps
# rate-limited endpoints answering while Redis is briefly unreachable.
if settings.redis_url:
    os.environ.setdefault("RATELIMIT_STORAGE_URL", settings.redis_url)
    os.environ.setdefault("RATELIMIT_IN_MEMORY_FALLBACK_ENABLED", "true")
