# Database Backup & Restore

## Quick Start

### Create a Backup

```bash
./scripts/backup.sh
```

This creates a gzip-compressed dump at `backups/net2map_YYYYMMDD_HHMMSS.sql.gz`.

### Restore a Backup

```bash
./scripts/restore.sh backups/net2map_20260320_120000.sql.gz
```

The script will ask for confirmation before overwriting the existing database.

---

## Manual Commands

If you prefer to run the commands directly:

### Manual Backup

```bash
docker exec net2map-postgres \
    pg_dump -U net2map -d net2map --no-owner --no-acl \
    | gzip > backups/net2map_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Manual Restore

```bash
# Drop and recreate the database
docker exec net2map-postgres psql -U net2map -d postgres \
    -c "DROP DATABASE IF EXISTS net2map;" \
    -c "CREATE DATABASE net2map OWNER net2map;"

# Restore from a .sql.gz file
gunzip -c backups/net2map_20260320_120000.sql.gz \
    | docker exec -i net2map-postgres psql -U net2map -d net2map -q

# Restore from a plain .sql file
docker exec -i net2map-postgres psql -U net2map -d net2map -q \
    < backups/net2map_20260320_120000.sql
```

---

## Automated Backups with Cron

Add a cron job to run the backup script on a schedule:

```bash
# Edit crontab
crontab -e

# Daily backup at 02:00
0 2 * * * /path/to/net2map/scripts/backup.sh >> /var/log/net2map-backup.log 2>&1

# Weekly backup every Sunday at 03:00
0 3 * * 0 /path/to/net2map/scripts/backup.sh >> /var/log/net2map-backup.log 2>&1
```

Replace `/path/to/net2map` with the actual absolute path to the project root.

### Retention (Optional)

To keep only the last 30 days of backups, add a cleanup line after the backup job:

```bash
0 2 * * * /path/to/net2map/scripts/backup.sh >> /var/log/net2map-backup.log 2>&1 && find /path/to/net2map/backups -name "*.sql.gz" -mtime +30 -delete
```

---

## Application Config Export/Import

Database backups cover all persistent data (switches, scans, audit logs, credentials, etc.).
Application-level settings stored in the database are included in the pg_dump.

Environment-based configuration (`.env` file) is **not** included in database backups.
Keep a separate copy of your `.env` file -- it contains secrets like `POSTGRES_PASSWORD`,
`SECRET_TOKEN`, `JWT_SECRET`, and `ENCRYPTION_KEY`.

---

## Notes

- The `backups/` directory is git-ignored to prevent accidental commits of large dump files.
- Backup files can be moved off-server for disaster recovery.
- The restore script terminates active database connections before dropping the database.
- Backups created before v3.0.0 are named `netmap_*.sql.gz`; they restore unchanged.
