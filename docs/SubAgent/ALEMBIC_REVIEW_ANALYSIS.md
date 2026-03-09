# Alembic Migration Review Analysis

## 1. Overview

The project uses Alembic for PostgreSQL schema migrations with 10 migration files (001-009, with a duplicate at 003). The backend is a FastAPI / SQLAlchemy application. Migrations are executed via `entrypoint.sh` before the application starts.

---

## 2. Configuration Review

### 2.1 alembic.ini

| Setting | Value | Assessment |
|---------|-------|------------|
| `script_location` | `/app/alembic` | Absolute Docker path. Works inside container. Will NOT work for local dev without Docker. |
| `prepend_sys_path` | `.` | Correct -- allows `from database import Base` in env.py |
| `file_template` | `%%(rev)s_%%(slug)s` | Matches naming convention used (e.g. `001_initial_schema.py`) |
| `version_locations` | `%(here)s/alembic/versions` | Uses relative path from .ini location. Correct. |
| `sqlalchemy.url` | (not set) | Overridden by env.py at runtime. Correct approach. |

**Issue**: No `sqlalchemy.url` placeholder is set in `[alembic]` section. PostgreSQL dialects require `psycopg2` or `asyncpg` to be importable. This is fine since `env.py` overrides it, but a developer running `alembic history` locally without `DATABASE_URL` set would get a RuntimeError.

### 2.2 alembic/env.py

- Requires `DATABASE_URL` environment variable -- raises `RuntimeError` if missing. Good security practice (no hardcoded credentials).
- Imports `Base` from `database.py` to populate `target_metadata`. Correct.
- Does NOT set `render_as_batch=True` -- fine since the project targets PostgreSQL exclusively now (batch mode is only needed for SQLite ALTER TABLE limitations).
- Does NOT set `compare_type=True` in `context.configure()` -- means `alembic check` or autogenerate won't detect column type changes. Minor, but useful to add for development workflows.
- Uses `pool.NullPool` for online migrations -- correct best practice to avoid connection pooling during migrations.

### 2.3 entrypoint.sh

- Waits for PostgreSQL to be ready (socket check on port 5432, up to 60s). Correct.
- Runs `gosu appuser alembic -c /app/alembic.ini upgrade head`. Correct -- migrations run as non-root user.
- No `alembic stamp head` fallback for initial deployments explicitly, but `upgrade head` from an empty DB is equivalent when all migrations start from `001`.

### 2.4 docker-compose.yml

- `DATABASE_URL` set to `postgresql://netmap:${POSTGRES_PASSWORD:-netmap_pw}@postgres/netmap`. Correct.
- Backend depends on `postgres` with `condition: service_healthy`. Good.
- Celery worker does NOT run migrations (correct -- only the backend entrypoint does).

### 2.5 database.py create_tables()

- `Base.metadata.create_all(bind=engine)` still runs at app startup as a fallback for bare-Python local dev.
- In Docker, `alembic upgrade head` already created the tables, so `create_all()` is a no-op. Correct.
- `_seed_default_settings()` uses `ON CONFLICT (key) DO NOTHING` -- idempotent. Good.

---

## 3. CRITICAL: Duplicate Revision ID "003"

**Two migration files share revision ID "003" with the same `down_revision = "002"`:**

| File | Revision | Down Revision | Purpose |
|------|----------|---------------|---------|
| `003_add_cascade_deletes.py` | `003` | `002` | Add ON DELETE CASCADE to all FKs |
| `003_add_switch_class_allow_outside_rack.py` | `003` | `002` | Add `allow_outside_rack` column |

This creates a **branch** in the migration DAG. Alembic will detect **two heads** and refuse to run `upgrade head` with:

```
alembic.util.exc.CommandError: Multiple head revisions are present; please specify a specific target revision
```

**Impact**: Alembic migrations will FAIL in any fresh deployment unless one of these files is re-numbered or merged.

**Root cause**: Both migrations were created independently, both derived from revision 002, and neither was renumbered to chain sequentially.

**Required fix**: One of these files must be renumbered. The cascade deletes migration (003) should remain as 003, and the `allow_outside_rack` migration should become 003b or be merged into 003 (or renumbered to depend on the cascade migration).

---

## 4. Migration Chain Analysis

### Expected Linear Chain

```
None -> 001 -> 002 -> 003 -> 004 -> 005 -> 006 -> 007 -> 008 -> 009
```

### Actual Chain (BROKEN)

```
None -> 001 -> 002 -> 003 (cascade)        -> 004 -> 005 -> 006 -> 007 -> 008 -> 009
                    \-> 003 (outside_rack)  [ORPHAN BRANCH -- 004 picks 003 but which one?]
```

Migration 004 has `down_revision = "003"`. Since two files share revision "003", Alembic cannot resolve the dependency unambiguously. This is a fatal configuration error.

### Date inconsistency

| Migration | Docstring Date | Notes |
|-----------|---------------|-------|
| 001 | 2026-02-23 | OK |
| 002 | 2026-02-24 | OK |
| 003 (cascade) | **2025-07-24** | Predates 001. Impossible -- metadata error. |
| 003 (outside_rack) | 2026-02-25 | OK |
| 004 | **2025-07-24** | Predates 001. Impossible -- metadata error. |
| 005 | **2025-07-25** | Predates 001. Impossible -- metadata error. |
| 006 | (no date) | N/A |
| 007 | (no date) | N/A |
| 008 | (no date) | N/A |
| 009 | (no date) | N/A |

The dates in 003 (cascade), 004, and 005 appear to be from an earlier development cycle or were copied incorrectly. Not functionally impactful but misleading.

---

## 5. Per-Migration Analysis

### 5.1 Migration 001 -- Initial Schema

**Creates 11 tables**: racks, switch_classes, switch_models, snmp_profiles, app_settings, scan_runs, topology_links, credentials, devices, ports, scan_run_switch_metrics.

**Assessment**: Generally correct. Tables created in dependency order. Downgrade drops in reverse order. Foreign keys defined correctly.

**Issues**:
- `credentials` table has `sa.UniqueConstraint("ip")` but no standalone `index=True` on `ip`. The model defines `index=True` on ip. A unique constraint implicitly creates a unique index in PostgreSQL, so functionally equivalent -- but after migration 008 drops this unique constraint, the standalone index is lost.
- `scan_runs.devices_snapshot_json` and `links_snapshot_json` created as `sa.Text()`. The model now defines them as `JSONB`. Migration 004 converts them. Correct cumulatively.
- `ports.endpoint_details_json` created as `sa.Text()`. Same JSONB conversion in 004. Correct cumulatively.
- Many columns use `nullable=True` (implicit) with no `server_default`, while the model specifies `default=""` or similar Python-level defaults. This is acceptable for ORM usage but means raw SQL inserts without these columns succeed with NULL rather than empty string.

### 5.2 Migration 002 -- Add `devices.ignored`

- Adds `ignored Boolean NOT NULL DEFAULT false`. Correct.
- Uses `server_default="false"` for existing rows. Correct.
- Downgrade drops the column. Correct.
- Matches model: `ignored = Column(Boolean, default=False, nullable=False)`. Consistent.

**No issues.**

### 5.3 Migration 003 (cascade) -- Add ON DELETE CASCADE

- Introspects existing FK names via `inspect(connection).get_foreign_keys()`. Good approach.
- Drops old FK, creates new one with `ondelete="CASCADE"`.
- Uses raw SQL `DROP CONSTRAINT IF EXISTS` -- PostgreSQL-specific. Acceptable since project targets PostgreSQL.
- Downgrade recreates FKs without CASCADE. Correct.
- Covers all 8 foreign keys in the schema. Complete.

**Issue**: Shares revision ID "003" with another migration (see Section 3).

### 5.4 Migration 003 (outside_rack) -- Add `switch_classes.allow_outside_rack`

- Adds `allow_outside_rack Boolean NOT NULL DEFAULT false`. Correct.
- Uses `sa.text("false")` for `server_default` -- correct PostgreSQL syntax.
- **Notable**: Calls `op.alter_column()` to remove `server_default` after applying it. This means after the migration, the column has no server default. The model has `default=False` (Python-level only). This is intentional style where the server_default is only used to populate existing rows.
- Downgrade drops the column. Correct.

**Issue**: Shares revision ID "003" (CRITICAL -- see Section 3).

### 5.5 Migration 004 -- Convert Text to JSONB

- Converts 3 columns from `TEXT` to `JSONB` using `ALTER TABLE ... ALTER COLUMN ... TYPE JSONB USING ...::jsonb`.
- Sets JSONB defaults: `'[]'::jsonb`. Correct.
- Downgrade converts back to TEXT. Correct and reversible.
- PostgreSQL-specific raw SQL. Acceptable.

**No issues** (apart from depending on the broken 003 chain).

### 5.6 Migration 005 -- Seed Settings

- Pure DML: INSERT 7 setting rows with `ON CONFLICT (key) DO NOTHING`. Idempotent. Good.
- Downgrade DELETEs those 7 rows. Correct.
- `scan_max_workers` seeded as `'4'` here, but `_seed_default_settings()` in database.py sets it to `'12'`. There is a discrepancy: on fresh installs, migration 005 inserts `'4'`, then `_seed_default_settings()` runs and tries to insert `'12'` but `ON CONFLICT DO NOTHING` means it stays at `'4'`.

**Issue**: `scan_max_workers` default mismatch between migration (4) and database.py seed (12). The migration value wins on fresh installs.

### 5.7 Migration 006 -- Users Table

- Creates `users` table with all required columns. Correct.
- Seeds default admin user using `bcrypt.hashpw()` at migration time.
- **Concern**: Depends on `bcrypt` and `DEFAULT_ADMIN_PASSWORD` env var being available during migration execution. Since this runs inside Docker where all dependencies are installed and env vars are set, this works. But running migrations locally without `DEFAULT_ADMIN_PASSWORD` defaults to `"changeme"`.
- No `ON CONFLICT` on the admin INSERT -- acceptable since this runs on a freshly created table.
- Downgrade drops the entire table. Correct.

**Minor issue**: No index explicitly created on `username` in the migration despite `index=True` in model. However, using `unique=True` in `sa.Column("username", ..., unique=True, index=True)` should create both constraints. Looking at the migration code, it uses `unique=True` and `index=True` in the Column definition, which Alembic handles correctly.

### 5.8 Migration 007 -- Audit Logs Table

- Creates `audit_logs` table with JSONB `details` column (server_default="{}"). Correct.
- Index on `timestamp`. Correct -- matches model.
- No foreign key on `user_id` to `users` table. Intentional -- the model also has no FK. This is a design choice: audit logs survive even if users are deleted.
- Downgrade drops table. Correct.

**No issues.**

### 5.9 Migration 008 -- Credential Priority / Fallback

- Adds `priority` Integer column with `server_default="0"`. Correct.
- Drops old unique constraint `credentials_ip_key` on `ip`.
- Creates new composite unique constraint `uq_credential_ip_priority` on `(ip, priority)`. Matches model.
- Downgrade reverses: drops composite UQ, recreates `credentials_ip_key` on `ip`, drops column. Correct.

**Issue**: After this migration, there is no standalone index on `credentials.ip`, but the model defines `index=True` on ip. The composite unique constraint covers `(ip, priority)` which can serve as an index for ip-prefix queries, but it is not a dedicated index on ip alone. Minor schema drift.

### 5.10 Migration 009 -- Dry Run Results

- Creates `dry_run_results` table with FK to `scan_runs.id`.
- Uses JSONB for `preview_json` with `server_default="[]"`. Correct.
- FK has no `ondelete` clause. Consistent with the model (no cascade defined). But note: migration 003 adds CASCADE to the `scan_run_switch_metrics.scan_run_id` FK. If a scan_run is deleted, switch_metrics cascade-delete but dry_run_results would cause a FK violation. **This is a potential runtime bug** -- deleting a scan_run with associated dry_run_results will fail.
- Downgrade drops table. Correct.

**Issue**: Missing `ondelete="CASCADE"` (or `SET NULL`) on the FK to `scan_runs.id` to match the cascade pattern established in migration 003.

---

## 6. Schema Drift Analysis

### 6.1 Column Type Mismatches (Cumulative Result = OK)

These columns were created as one type and converted by later migrations:

| Table | Column | Migration 001 Type | Current Model Type | Fixed In Migration |
|-------|--------|-------------------|-------------------|-------------------|
| scan_runs | devices_snapshot_json | Text | JSONB | 004 |
| scan_runs | links_snapshot_json | Text | JSONB | 004 |
| ports | endpoint_details_json | Text | JSONB | 004 |

All resolved correctly by migration 004.

### 6.2 Missing server_default Values

Many columns in the model use `default=` (Python-level) but migrations create them as `nullable=True` with no `server_default`. This is not strictly wrong for ORM-only usage but means direct SQL inserts may produce NULLs where empty strings are expected.

Examples:
- `racks.room` -- model `default=""`, migration nullable=True
- `racks.description` -- model `default=""`, migration nullable=True
- `devices.sys_descr` -- model `default=""`, migration nullable=True
- Many SNMP credential/profile string columns

### 6.3 Seed Data Discrepancy

| Setting Key | Migration 005 Value | database.py Seed Value | Winner |
|-------------|--------------------|-----------------------|--------|
| scan_max_workers | '4' | '12' | '4' (migration runs first, ON CONFLICT DO NOTHING in seed) |

### 6.4 Missing Index on credentials.ip

- Model: `ip = Column(String, nullable=False, index=True)`
- After migration 008: unique constraint on `(ip, priority)` replaces standalone unique on `ip`. No standalone index on `ip`.
- Impact: Queries filtering by `ip` alone may not use the composite index efficiently (though PostgreSQL usually can use leading column of a composite index/constraint).
- Severity: Low -- composite unique effectively serves as ip index since ip is the leading column.

### 6.5 Missing CASCADE on dry_run_results.scan_run_id

- Model: `scan_run_id = Column(Integer, ForeignKey("scan_runs.id"), nullable=True)` -- no ondelete
- Migration 009: Same -- no ondelete
- But migration 003 added CASCADE to `scan_run_switch_metrics.scan_run_id`
- If a scan_run is deleted: switch_metrics cascade-delete, but dry_run_results with the same scan_run_id would block the DELETE with a FK violation.
- Severity: Medium -- will cause runtime errors when deleting scan runs that have dry_run_results.

---

## 7. Summary of Issues

### CRITICAL

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **Duplicate revision ID "003"** -- two migration files share the same revision, creating a branched DAG | `003_add_cascade_deletes.py` and `003_add_switch_class_allow_outside_rack.py` | Alembic `upgrade head` fails on fresh deployments with "Multiple head revisions" error |

### MEDIUM

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 2 | Missing `ondelete="CASCADE"` on `dry_run_results.scan_run_id` FK | Migration 009, database.py model | Deleting a scan_run with associated dry_run_results raises IntegrityError |
| 3 | `scan_max_workers` seed value discrepancy (migration=4, database.py=12) | Migration 005 vs database.py `_seed_default_settings()` | Fresh installs get max_workers=4 instead of the intended 12 |

### LOW

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 4 | No standalone index on `credentials.ip` after migration 008 | Migration 008 | Negligible -- composite UQ on (ip, priority) covers ip-prefix queries |
| 5 | Missing `compare_type=True` in env.py `context.configure()` | `alembic/env.py` | `alembic check` won't detect column type drift |
| 6 | Date metadata errors in migrations 003 (cascade), 004, 005 | Migration docstrings | Misleading but no functional impact |
| 7 | Many columns lack `server_default` matching model `default=` | Multiple tables | NULLs in raw-SQL inserts where empty strings expected. Not a problem for ORM usage |
| 8 | `script_location = /app/alembic` is Docker-only | `alembic.ini` | Cannot run alembic locally without Docker. Minor -- the project is Docker-centric |

---

## 8. Recommendations

### Immediate (must fix)

1. **Resolve duplicate revision 003**: Rename `003_add_switch_class_allow_outside_rack.py` to have a unique revision (e.g., `003b`) with `down_revision = "003"` pointing to the cascade migration. Update migration 004's `down_revision` to `"003b"`. Alternatively, merge both 003 migrations into a single file.

2. **Add CASCADE to dry_run_results FK**: Create a new migration (010) that drops and recreates the FK with `ondelete="CASCADE"` or `ondelete="SET NULL"`.

### Recommended

3. **Fix scan_max_workers default**: Update migration 005 to seed `scan_max_workers` as `'12'` to match database.py (or vice versa).

4. **Add `compare_type=True`** to `context.configure()` in env.py for better autogenerate support.

5. **Fix migration date metadata** in 003 (cascade), 004, and 005 docstrings.
