#!/bin/sh
# entrypoint.sh â€” fixes /data ownership for Docker volume mounts, then:
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

echo "[entrypoint] Waiting for Redis..."
python3 -c "
import os, time, sys, socket
url = os.environ.get('REDIS_URL', '')
if not url:
    print('[entrypoint] No REDIS_URL set, skipping Redis check.')
    sys.exit(0)
try:
    host = url.split('://')[1].split(':')[0].split('/')[0]
    port = int(url.split('://')[1].split(':')[1].split('/')[0]) if ':' in url.split('://')[1] else 6379
except Exception:
    host, port = 'redis', 6379
for i in range(30):
    try:
        socket.create_connection((host, port), timeout=2).close()
        print(f'[entrypoint] Redis at {host}:{port} is ready.')
        sys.exit(0)
    except OSError:
        time.sleep(1)
print('[entrypoint] WARNING: Redis not reachable after 30s, continuing anyway')
sys.exit(0)
"

# Migrations run only in containers that own the schema lifecycle (the backend
# service). Worker images (celery-worker, celery-beat) share this entrypoint but
# set RUN_MIGRATIONS=false: they lack DEFAULT_ADMIN_PASSWORD, so a worker winning
# the first-boot race would seed the admin with the "changeme" fallback and can
# collide with the backend on the alembic_version table.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
    echo "[entrypoint] Running Alembic migrations..."
    gosu appuser alembic -c /app/alembic.ini upgrade head
else
    echo "[entrypoint] RUN_MIGRATIONS=false, skipping Alembic migrations."
fi

exec gosu appuser "$@"
