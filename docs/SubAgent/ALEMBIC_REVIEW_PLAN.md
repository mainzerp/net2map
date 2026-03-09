# Alembic Review -- Implementation Plan

Based on analysis in [ALEMBIC_REVIEW_ANALYSIS.md](ALEMBIC_REVIEW_ANALYSIS.md).

---

## Summary of Issues

| # | Severity | Issue | Files Affected |
|---|----------|-------|----------------|
| 1 | CRITICAL | Duplicate revision "003" -- two migration files share the same revision ID, creating a broken DAG | `003_add_cascade_deletes.py`, `003_add_switch_class_allow_outside_rack.py`, `004_jsonb_snapshot_columns.py` |
| 2 | MEDIUM | Missing `ondelete="CASCADE"` on `dry_run_results.scan_run_id` FK | `backend/database.py`, new migration `010_*` |
| 3 | MEDIUM | `scan_max_workers` seed value mismatch: migration 005 seeds `'4'`, database.py seeds `'12'` | `backend/alembic/versions/005_settings_to_db.py` |
| 4 | LOW | Missing `compare_type=True` in env.py `context.configure()` | `backend/alembic/env.py` |
| 5 | LOW | Incorrect date metadata in migration docstrings | `003_add_cascade_deletes.py`, `004_jsonb_snapshot_columns.py`, `005_settings_to_db.py` |

---

## Fix 1: CRITICAL -- Resolve Duplicate Revision "003"

### Current State

```
None -> 001 -> 002 -> 003 (cascade)        -> 004 -> ...
                   \-> 003 (outside_rack)   [ORPHAN BRANCH]
```

Both files:
- `003_add_cascade_deletes.py` -- revision `"003"`, down_revision `"002"`
- `003_add_switch_class_allow_outside_rack.py` -- revision `"003"`, down_revision `"002"`

Migration 004 has `down_revision = "003"`, which is ambiguous.

### Target State

```
None -> 001 -> 002 -> 003 (cascade) -> 003b (outside_rack) -> 004 -> 005 -> ... -> 009
```

### Steps

- [ ] **1.1** Rename file `003_add_switch_class_allow_outside_rack.py` to `003b_add_switch_class_allow_outside_rack.py`

- [ ] **1.2** Edit `003b_add_switch_class_allow_outside_rack.py` -- change revision metadata:
  - `revision: str = "003"` -> `revision: str = "003b"`
  - `down_revision: Union[str, None] = "002"` -> `down_revision: Union[str, None] = "003"`

- [ ] **1.3** Edit `004_jsonb_snapshot_columns.py` -- update down_revision:
  - `down_revision: Union[str, None] = "003"` -> `down_revision: Union[str, None] = "003b"`

### Resulting Chain

| File | revision | down_revision |
|------|----------|---------------|
| `001_initial_schema.py` | `001` | `None` |
| `002_add_device_ignored.py` | `002` | `001` |
| `003_add_cascade_deletes.py` | `003` | `002` |
| `003b_add_switch_class_allow_outside_rack.py` | `003b` | `003` |
| `004_jsonb_snapshot_columns.py` | `004` | `003b` |
| `005_settings_to_db.py` | `005` | `004` |
| ... | ... | ... |
| `009_dry_run_results.py` | `009` | `008` |

---

## Fix 2: MEDIUM -- Add CASCADE to dry_run_results FK

### Problem

The `dry_run_results.scan_run_id` foreign key in migration 009 has no `ondelete` behavior. The model in `database.py` also lacks `ondelete="CASCADE"`. Since all other FKs in the project use CASCADE (added in migration 003), this FK should too.

### Steps

- [ ] **2.1** Edit `backend/database.py` -- add `ondelete="CASCADE"` to the `DryRunResult.scan_run_id` column:
  ```python
  # Before:
  scan_run_id  = Column(Integer, ForeignKey("scan_runs.id"), nullable=True)
  # After:
  scan_run_id  = Column(Integer, ForeignKey("scan_runs.id", ondelete="CASCADE"), nullable=True)
  ```

- [ ] **2.2** Create new migration file `backend/alembic/versions/010_dry_run_cascade.py`:
  ```python
  """Add ON DELETE CASCADE to dry_run_results.scan_run_id FK.

  Revision ID: 010
  Revises: 009
  """
  from alembic import op

  revision = "010"
  down_revision = "009"
  branch_labels = None
  depends_on = None

  _TABLE = "dry_run_results"
  _COL = "scan_run_id"
  _REF_TABLE = "scan_runs"
  _REF_COL = "id"
  _NEW_FK = "fk_dry_run_results_scan_run_id"


  def upgrade():
      # Drop the unnamed FK created by migration 009, then recreate with CASCADE.
      # Introspect to find the auto-generated FK name.
      from sqlalchemy import inspect, text
      conn = op.get_bind()
      insp = inspect(conn)
      for fk in insp.get_foreign_keys(_TABLE):
          if (fk["constrained_columns"] == [_COL]
                  and fk["referred_table"] == _REF_TABLE):
              conn.execute(text(
                  f'ALTER TABLE "{_TABLE}" DROP CONSTRAINT IF EXISTS "{fk["name"]}"'
              ))
              break
      op.create_foreign_key(
          _NEW_FK, _TABLE, _REF_TABLE, [_COL], [_REF_COL], ondelete="CASCADE"
      )


  def downgrade():
      op.drop_constraint(_NEW_FK, _TABLE, type_="foreignkey")
      op.create_foreign_key(None, _TABLE, _REF_TABLE, [_COL], [_REF_COL])
  ```

---

## Fix 3: MEDIUM -- Fix scan_max_workers Seed Value

### Problem

Migration 005 inserts `scan_max_workers = '4'`. The `_seed_default_settings()` function in `database.py` tries to insert `scan_max_workers = '12'`, but uses `ON CONFLICT DO NOTHING`, so fresh installs keep the migration's value of `'4'`.

The intended default is `'12'` (as set in database.py). The migration should match.

### Steps

- [ ] **3.1** Edit `backend/alembic/versions/005_settings_to_db.py` -- change the seed value:
  ```
  # Before:
  ('scan_max_workers',  '4'),
  # After:
  ('scan_max_workers',  '12'),
  ```

---

## Fix 4: LOW -- Add compare_type=True to env.py

### Problem

Without `compare_type=True`, `alembic check` and autogenerate will not detect column type changes (e.g., TEXT -> JSONB). This is useful for development.

### Steps

- [ ] **4.1** Edit `backend/alembic/env.py` -- add `compare_type=True` to the `context.configure()` call in `run_migrations_offline()`:
  ```python
  context.configure(
      url=url,
      target_metadata=target_metadata,
      literal_binds=True,
      dialect_opts={"paramstyle": "named"},
      compare_type=True,
  )
  ```

- [ ] **4.2** Edit `backend/alembic/env.py` -- add `compare_type=True` to the `context.configure()` call in `run_migrations_online()`:
  ```python
  context.configure(
      connection=connection,
      target_metadata=target_metadata,
      compare_type=True,
  )
  ```

---

## Fix 5: LOW -- Fix Incorrect Date Metadata

### Problem

Three migrations have docstring dates that predate migration 001 (2026-02-23):
- `003_add_cascade_deletes.py`: `2025-07-24` (should be `2026-02-25`)
- `004_jsonb_snapshot_columns.py`: `2025-07-24` (should be `2026-02-25`)
- `005_settings_to_db.py`: `2025-07-25` (should be `2026-02-25`)

### Steps

- [ ] **5.1** Edit `003_add_cascade_deletes.py` docstring:
  - `Create Date: 2025-07-24` -> `Create Date: 2026-02-25`

- [ ] **5.2** Edit `004_jsonb_snapshot_columns.py` docstring:
  - `Create Date: 2025-07-24` -> `Create Date: 2026-02-25`

- [ ] **5.3** Edit `005_settings_to_db.py` docstring:
  - `Create Date: 2025-07-25` -> `Create Date: 2026-02-25`

---

## Implementation Checklist

| Step | Severity | Description | Status |
|------|----------|-------------|--------|
| 1.1 | CRITICAL | Rename `003_add_switch_class_allow_outside_rack.py` -> `003b_add_switch_class_allow_outside_rack.py` | [ ] |
| 1.2 | CRITICAL | Update revision/down_revision in renamed `003b_*` file | [ ] |
| 1.3 | CRITICAL | Update `004_*` down_revision from `"003"` to `"003b"` | [ ] |
| 2.1 | MEDIUM | Add `ondelete="CASCADE"` to `DryRunResult.scan_run_id` in database.py | [ ] |
| 2.2 | MEDIUM | Create migration `010_dry_run_cascade.py` | [ ] |
| 3.1 | MEDIUM | Change `scan_max_workers` from `'4'` to `'12'` in migration 005 | [ ] |
| 4.1 | LOW | Add `compare_type=True` to `run_migrations_offline()` in env.py | [ ] |
| 4.2 | LOW | Add `compare_type=True` to `run_migrations_online()` in env.py | [ ] |
| 5.1 | LOW | Fix date in `003_add_cascade_deletes.py` docstring | [ ] |
| 5.2 | LOW | Fix date in `004_jsonb_snapshot_columns.py` docstring | [ ] |
| 5.3 | LOW | Fix date in `005_settings_to_db.py` docstring | [ ] |

---

## Verification

After implementation, verify the migration chain is correct:

1. Run `alembic heads` -- should show exactly ONE head (`010`)
2. Run `alembic history` -- should show a single linear chain: `None -> 001 -> 002 -> 003 -> 003b -> 004 -> 005 -> 006 -> 007 -> 008 -> 009 -> 010`
3. Run `alembic check` -- should report no schema drift (except possibly known diffs like missing standalone index on `credentials.ip`)

---

## Files Modified

| File | Action |
|------|--------|
| `backend/alembic/versions/003_add_switch_class_allow_outside_rack.py` | Rename to `003b_*`, update revision metadata |
| `backend/alembic/versions/004_jsonb_snapshot_columns.py` | Update down_revision to `"003b"` |
| `backend/alembic/versions/005_settings_to_db.py` | Fix seed value + docstring date |
| `backend/alembic/versions/003_add_cascade_deletes.py` | Fix docstring date |
| `backend/alembic/env.py` | Add `compare_type=True` |
| `backend/database.py` | Add `ondelete="CASCADE"` to DryRunResult FK |
| `backend/alembic/versions/010_dry_run_cascade.py` | New file -- CASCADE migration |
