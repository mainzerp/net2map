#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh -- Create a compressed PostgreSQL backup via Docker
#
# Usage:
#   ./scripts/backup.sh
#
# The script runs pg_dump inside the net2map-postgres container and writes a
# gzip-compressed SQL dump to backups/net2map_YYYYMMDD_HHMMSS.sql.gz.
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
CONTAINER="net2map-postgres"
DB_NAME="net2map"
DB_USER="net2map"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/net2map_${TIMESTAMP}.sql.gz"

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

# Write to a temp file in the target directory so the final mv is atomic and
# a failed or interrupted dump never leaves a truncated *.sql.gz behind.
TMP_FILE="$(mktemp "${BACKUP_DIR}/.net2map_${TIMESTAMP}.sql.gz.tmp.XXXXXX")"

cleanup() {
    if [ -n "${TMP_FILE:-}" ] && [ -e "$TMP_FILE" ]; then
        rm -f -- "$TMP_FILE"
    fi
}
trap cleanup EXIT
trap 'echo "ERROR: Backup failed; partial output removed." >&2' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

docker exec "$CONTAINER" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
    | gzip > "$TMP_FILE"

# ── Verify output ─────────────────────────────────────────────────────────
if [ ! -s "$TMP_FILE" ]; then
    echo "ERROR: Backup file is empty or was not created." >&2
    exit 1
fi

if ! gzip -t -- "$TMP_FILE"; then
    echo "ERROR: Backup file failed gzip integrity check." >&2
    exit 1
fi

mv -f -- "$TMP_FILE" "$BACKUP_FILE"
TMP_FILE=""

FILE_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "Backup complete: ${BACKUP_FILE} (${FILE_SIZE})"
