#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh -- Create a compressed PostgreSQL backup via Docker
#
# Usage:
#   ./scripts/backup.sh
#
# The script runs pg_dump inside the netmap-postgres container and writes a
# gzip-compressed SQL dump to backups/netmap_YYYYMMDD_HHMMSS.sql.gz.
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
CONTAINER="netmap-postgres"
DB_NAME="netmap"
DB_USER="netmap"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/netmap_${TIMESTAMP}.sql.gz"

# ── Pre-flight checks ─────────────────────────────────────────────────────

# 1. Docker must be available
if ! command -v docker &>/dev/null; then
    echo "ERROR: docker is not installed or not in PATH." >&2
    exit 1
fi

# 2. Docker daemon must be running
if ! docker info &>/dev/null; then
    echo "ERROR: Docker daemon is not running." >&2
    exit 1
fi

# 3. Target container must exist and be running
if ! docker inspect --format='{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q "true"; then
    echo "ERROR: Container '${CONTAINER}' is not running." >&2
    echo "       Start the stack first: docker compose up -d" >&2
    exit 1
fi

# ── Create backup directory if needed ──────────────────────────────────────
mkdir -p "$BACKUP_DIR"

# ── Run pg_dump ────────────────────────────────────────────────────────────
echo "Starting backup of database '${DB_NAME}' from container '${CONTAINER}'..."

docker exec "$CONTAINER" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
    | gzip > "$BACKUP_FILE"

# ── Verify output ─────────────────────────────────────────────────────────
if [ ! -s "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file is empty or was not created." >&2
    rm -f "$BACKUP_FILE"
    exit 1
fi

FILE_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "Backup complete: ${BACKUP_FILE} (${FILE_SIZE})"
