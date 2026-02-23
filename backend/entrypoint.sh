#!/bin/sh
# entrypoint.sh — fixes /data ownership for Docker volume mounts, then:
#   1. Runs Alembic migrations (creates or migrates the SQLite schema)
#   2. Drops privileges to appuser
#   3. Starts uvicorn
set -e

chown -R appuser:appuser /data
chmod 700 /data

# ---------------------------------------------------------------------------
# Alembic migration gate
#
# For brand-new databases:  upgrade head creates all tables.
# For databases that existed before Alembic was introduced (no alembic_version
# table but other tables present): stamp head first so Alembic knows the schema
# is already at revision 001, then upgrade head is a no-op.
# ---------------------------------------------------------------------------
DB_PATH=$(python3 -c "
import os
url = os.environ.get('DATABASE_URL', 'sqlite:////data/netmap.db')
# Strip sqlite:/// prefix — handles both relative (./x.db) and absolute (////data/x.db)
path = url.replace('sqlite://', '').lstrip('/')
if not path.startswith('/'):
    path = '/' + path
print(path)
")

if [ -f "$DB_PATH" ]; then
    HAS_ALEMBIC=$(python3 -c "
import sqlite3, sys
try:
    conn = sqlite3.connect('$DB_PATH')
    tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
    conn.close()
    print('yes' if 'alembic_version' in tables else 'no')
except Exception:
    print('yes')  # assume managed, let upgrade handle it
")
    if [ "$HAS_ALEMBIC" = "no" ]; then
        echo "[entrypoint] Existing database detected without alembic_version — stamping at head."
        gosu appuser alembic -c /app/alembic.ini stamp head
    fi
fi

echo "[entrypoint] Running Alembic migrations..."
gosu appuser alembic -c /app/alembic.ini upgrade head

exec gosu appuser "$@"
