#!/bin/sh
# entrypoint.sh — fixes /data ownership for Docker volume mounts, then:
#   1. Waits for PostgreSQL to be ready
#   2. Runs Alembic migrations (creates or migrates the schema)
#   3. Drops privileges to appuser
#   4. Starts uvicorn
set -e

chown -R appuser:appuser /data
chmod 700 /data

# ---------------------------------------------------------------------------
# Wait for PostgreSQL to accept connections before running migrations.
# DATABASE_URL is set by docker-compose; default targets the postgres service.
# ---------------------------------------------------------------------------
echo "[entrypoint] Waiting for PostgreSQL..."
python3 -c "
import os, time, sys
url = os.environ.get('DATABASE_URL', '')
if not url.startswith('postgresql'):
    sys.exit(0)
# Extract host from postgresql://user:pass@host/db
try:
    host = url.split('@')[1].split('/')[0].split(':')[0]
except Exception:
    host = 'postgres'
import socket
for i in range(60):
    try:
        socket.create_connection((host, 5432), timeout=2).close()
        print(f'[entrypoint] PostgreSQL at {host}:5432 is ready.')
        sys.exit(0)
    except OSError:
        time.sleep(1)
print('[entrypoint] ERROR: PostgreSQL not reachable after 60s')
sys.exit(1)
"

echo "[entrypoint] Running Alembic migrations..."
gosu appuser alembic -c /app/alembic.ini upgrade head

exec gosu appuser "$@"
