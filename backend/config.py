"""Centralized configuration via Pydantic BaseSettings."""
import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://net2map:net2map_pw@postgres/net2map"

    # Redis / Celery
    redis_url: str = ""

    # CORS
    cors_origin: str = "http://localhost:3000"

    # Authentication
    jwt_secret: str = ""
    jwt_expiry_hours: int = 24
    # Absolute session lifetime: /auth/refresh rejects a token chain once this
    # much time has passed since the original login (auth_time claim).
    jwt_max_session_hours: int = 168
    encryption_key: str = ""

    # Seed data
    default_admin_password: str = ""

    # Logging
    log_level: str = "INFO"

    # Audit
    audit_retention_days: int = 90

    # Request logging
    request_log_enabled: bool = False

    # API documentation: Swagger UI (/docs), ReDoc (/redoc), schema (/openapi.json)
    openapi_enabled: bool = True

    # extra="ignore": a stale .env (e.g. the removed SECRET_TOKEN) must not abort startup.
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()

# Admin passwords that must never be accepted as DEFAULT_ADMIN_PASSWORD.
_FORBIDDEN_ADMIN_PASSWORDS = {"", "changeme"}


def validate_required_settings(s: Settings | None = None) -> None:
    """Abort startup when a mandatory secret is missing or insecure.

    Raises RuntimeError listing every problem so an operator can fix them in
    one go. Called from the FastAPI lifespan before anything else runs.
    """
    s = settings if s is None else s
    problems = []
    if not s.jwt_secret:
        problems.append('JWT_SECRET is not set. Generate one with: python -c "import secrets; '
                        'print(secrets.token_hex(32))"')
    if not s.encryption_key:
        problems.append('ENCRYPTION_KEY is not set. Generate one with: python -c "from cryptography.fernet '
                        'import Fernet; print(Fernet.generate_key().decode())"')
    else:
        try:
            from cryptography.fernet import Fernet
            Fernet(s.encryption_key.encode())
        except Exception:
            problems.append("ENCRYPTION_KEY is not a valid Fernet key (32 url-safe base64-encoded bytes)")
    if s.default_admin_password.strip().lower() in _FORBIDDEN_ADMIN_PASSWORDS:
        problems.append('DEFAULT_ADMIN_PASSWORD is empty or the insecure default "changeme"; set a strong password')
    if problems:
        raise RuntimeError("Refusing to start, insecure configuration:\n- " + "\n- ".join(problems))


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
