"""Centralized configuration via Pydantic BaseSettings."""
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

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
