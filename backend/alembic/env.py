"""Alembic environment configuration for switch-map."""
import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

# ---------------------------------------------------------------------------
# Pull the Alembic Config object (gives access to .ini values)
# ---------------------------------------------------------------------------
config = context.config

# Override sqlalchemy.url from environment so the same ini works in Docker
# and in local bare-Python dev.
_db_url = os.environ.get("DATABASE_URL")
if not _db_url:
    raise RuntimeError("DATABASE_URL environment variable is required for migrations")
config.set_main_option("sqlalchemy.url", _db_url)

# ---------------------------------------------------------------------------
# Logging setup from alembic.ini
# ---------------------------------------------------------------------------
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ---------------------------------------------------------------------------
# Import ALL models so that Base.metadata is fully populated.
# database.py is on sys.path because alembic.ini sets prepend_sys_path = .
# and the container WORKDIR is /app where database.py lives.
# ---------------------------------------------------------------------------
from database import Base  # noqa: E402  — import after path is set up
# Importing database triggers all model class definitions (Rack, Device, etc.)
# No additional imports needed; all models are registered on Base.metadata.

target_metadata = Base.metadata

# ---------------------------------------------------------------------------
# Migration helper functions
# ---------------------------------------------------------------------------

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL to stdout, no DB connection)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (real DB connection)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
