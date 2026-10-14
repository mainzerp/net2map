#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore.sh -- Restore a PostgreSQL backup into the Docker container
#
# Usage:
#   ./scripts/restore.sh backups/net2map_20260320_120000.sql.gz
#   ./scripts/restore.sh backups/net2map_20260320_120000.sql
#
# Supports both plain .sql and gzip-compressed .sql.gz files.
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
CONTAINER="net2map-postgres"
DB_NAME="net2map"
DB_USER="net2map"

# ── Argument validation ───────────────────────────────────────────────────
if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup-file>" >&2
    echo "  Accepts .sql or .sql.gz files." >&2
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: File not found: ${BACKUP_FILE}" >&2
    exit 1
fi

# Validate the file before anything destructive happens: the database is
# dropped below, so an unsupported or corrupt file must be rejected here.
case "$BACKUP_FILE" in
    *.sql.gz)
        if ! gzip -t -- "$BACKUP_FILE"; then
            echo "ERROR: Backup file failed gzip integrity check: ${BACKUP_FILE}" >&2
            exit 1
        fi
        ;;
    *.sql)
        if [ ! -s "$BACKUP_FILE" ]; then
            echo "ERROR: Backup file is empty: ${BACKUP_FILE}" >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: Unsupported file format. Use .sql or .sql.gz" >&2
        exit 1
        ;;
esac

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

# ── Confirmation prompt ───────────────────────────────────────────────────
echo "WARNING: This will DROP and recreate the '${DB_NAME}' database."
echo "         All existing data will be overwritten."
echo ""
echo "Backup file: ${BACKUP_FILE}"
echo ""
CONFIRM=""
read -rp "Type 'yes' to continue: " CONFIRM || true

if [ "$CONFIRM" != "yes" ]; then
    echo "Restore cancelled."
    exit 0
fi

# ── Drop and recreate the database ────────────────────────────────────────
echo "Dropping and recreating database '${DB_NAME}'..."

docker exec "$CONTAINER" \
    psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS ${DB_NAME};" \
    -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

# ── Restore the dump ─────────────────────────────────────────────────────
echo "Restoring from ${BACKUP_FILE}..."

case "$BACKUP_FILE" in
    *.sql.gz)
        gunzip -c -- "$BACKUP_FILE" \
            | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" --single-transaction -q -v ON_ERROR_STOP=1
        ;;
    *.sql)
        docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" --single-transaction -q -v ON_ERROR_STOP=1 \
            < "$BACKUP_FILE"
        ;;
    *)
        echo "ERROR: Unsupported file format. Use .sql or .sql.gz" >&2
        exit 1
        ;;
esac

echo "Restore complete."
