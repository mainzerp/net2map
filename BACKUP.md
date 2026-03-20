# Database Backup & Restore

## Quick Start

### Create a Backup

```bash
./scripts/backup.sh
```

This creates a gzip-compressed dump at `backups/netmap_YYYYMMDD_HHMMSS.sql.gz`.

### Restore a Backup

```bash
./scripts/restore.sh backups/netmap_20260320_120000.sql.gz
```

The script will ask for confirmation before overwriting the existing database.

---

## Manual Commands

If you prefer to run the commands directly:

### Manual Backup

```bash
docker exec netmap-postgres \
    pg_dump -U netmap -d netmap --no-owner --no-acl \
    | gzip > backups/netmap_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Manual Restore

```bash
# Drop and recreate the database
docker exec netmap-postgres psql -U netmap -d postgres \
    -c "DROP DATABASE IF EXISTS netmap;" \
    -c "CREATE DATABASE netmap OWNER netmap;"

# Restore from a .sql.gz file
gunzip -c backups/netmap_20260320_120000.sql.gz \
    | docker exec -i netmap-postgres psql -U netmap -d netmap -q

# Restore from a plain .sql file
docker exec -i netmap-postgres psql -U netmap -d netmap -q \
    < backups/netmap_20260320_120000.sql
```

---

## Automated Backups with Cron

Add a cron job to run the backup script on a schedule:

```bash
# Edit crontab
crontab -e

# Daily backup at 02:00
0 2 * * * /path/to/switch-map/scripts/backup.sh >> /var/log/netmap-backup.log 2>&1

# Weekly backup every Sunday at 03:00
0 3 * * 0 /path/to/switch-map/scripts/backup.sh >> /var/log/netmap-backup.log 2>&1
```

Replace `/path/to/switch-map` with the actual absolute path to the project root.

### Retention (Optional)

To keep only the last 30 days of backups, add a cleanup line after the backup job:

```bash
0 2 * * * /path/to/switch-map/scripts/backup.sh >> /var/log/netmap-backup.log 2>&1 && find /path/to/switch-map/backups -name "*.sql.gz" -mtime +30 -delete
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
