# Container Fixes Analysis

## Issue 1: Celery worker can't find task `tasks.run_scan_task`

### Error
```
KeyError: 'tasks.run_scan_task'
Received unregistered task of type 'tasks.run_scan_task'
```

### Findings

**celery_app.py** (the Celery application):
- Creates a Celery app named `"netmap"` with Redis broker/backend.
- Does **NOT** set `include` or call `autodiscover_tasks()`.
- The app has zero knowledge of any task modules.

**tasks.py** (the task definition):
- Imports `celery_app` from `celery_app` module and decorates `run_scan_task` with `@celery_app.task(bind=True, ...)`.
- Because the task is decorated on the `celery_app` Celery instance, its **auto-generated full name** is `celery_app.run_scan_task` (derived from the module where `celery_app` is instantiated, NOT the module where the task function lives -- actually, Celery uses the module where the **task function** is defined, so the name is `tasks.run_scan_task`).

**docker-compose.yml** (celery-worker service):
- Command: `celery -A celery_app worker --loglevel=info --concurrency=2`
- `-A celery_app` tells Celery to load the app from `celery_app.py`.
- The Dockerfile sets `WORKDIR /app` and copies all backend files to `/app`.

**Root Cause**: The Celery worker starts with `-A celery_app`, which loads `celery_app.py` to get the Celery instance. However, `celery_app.py` does **not** declare an `include` list or call `autodiscover_tasks()`, so the `tasks` module is **never imported** by the worker process. Since `tasks.py` is never imported, the `@celery_app.task` decorator never runs, and the task is never registered.

When the **backend** calls `run_scan_task.delay(...)` (in `scan_engine.py`), it does `from tasks import run_scan_task` which causes the decorator to fire and register the task on that process's Celery instance. The task message is sent to Redis with the name `tasks.run_scan_task`. But the **worker** process never imported `tasks.py`, so when it receives this message, it has no registered handler for `tasks.run_scan_task` and throws the `KeyError`.

**Fix**: Add `include=["tasks"]` to the Celery app constructor in `celery_app.py`:
```python
celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL, include=["tasks"])
```

This ensures that when the worker starts with `-A celery_app`, it also imports the `tasks` module, registering all tasks defined there.

---

## Issue 2: Migration 003 constraint drop failure

### Error
```
constraint "ports_device_id_fkey" of relation "ports" does not exist
```

### Findings

**001_initial_schema.py** (initial migration):
- Creates the `ports` table with:
  ```python
  sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
  ```
- No explicit constraint name is provided in the migration.
- PostgreSQL auto-generates a constraint name. The default naming convention is `{table}_{column}_fkey`, which would be `ports_device_id_fkey`.

**003_add_cascade_deletes.py** (the failing migration):
- Uses a `_find_fk_name()` introspection helper that calls `inspect(connection).get_foreign_keys(table)` to locate the existing FK constraint name at runtime.
- If a constraint is found (`old_name` is truthy), it drops it via `op.drop_constraint(old_name, ...)`.
- If no constraint is found (`old_name` is None/empty), it skips the drop and creates the new named constraint.

**database.py** (SQLAlchemy models):
- `Port.device_id` uses `ForeignKey("devices.id")` with **no explicit constraint name**.
- All ForeignKey declarations across all models are unnamed.

**Root Cause Analysis**: The introspection-based approach in migration 003 is actually well-designed and should handle unnamed constraints. The error `constraint "ports_device_id_fkey" does not exist` suggests one of these scenarios:

1. **The database was partially migrated or the schema was created via `Base.metadata.create_all()`** before Alembic migrations were adopted. If `create_all()` created the schema, the Alembic version table might have been manually stamped at a revision after 001. When 003 runs, if the FK constraint was not present (e.g., the `ports` table exists but with a different schema), introspection returns `None`, the drop is skipped, but `create_foreign_key` could fail if a constraint already exists from a prior partial run.

2. **The migration ran partially on a first attempt**, dropping the original constraint and failing before creating the new one. On retry, introspection correctly finds no FK (it was already dropped), returns `None`, skips the drop, and proceeds to create -- which should work. But if the error occurs on the very first run, it means `_find_fk_name` IS finding a name (returning `"ports_device_id_fkey"`) and passing it to `drop_constraint`, but the constraint doesn't actually exist under that name in the database.

3. **PostgreSQL naming convention mismatch**: SQLAlchemy's `inspect()` may report a constraint name that differs from the actual PostgreSQL catalog name. This is unlikely but possible with schema differences between Alembic migrations and `create_all()`.

4. **Most likely: The `_find_fk_name` introspection returns a name, but the constraint with that exact name does not exist in the database**. This can happen if the schema was initialized without the FK constraints present (e.g., an older version of `create_all()` that didn't include the FK), but SQLAlchemy's inspector reports stale or incorrect metadata.

**Practical fix**: Add a safety check in the `upgrade()` function that catches the constraint-not-found error and continues gracefully, or add an explicit `IF EXISTS` check:
```python
def upgrade() -> None:
    conn = op.get_bind()
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        old_name = _find_fk_name(conn, table, col, ref_table)
        if old_name:
            try:
                op.drop_constraint(old_name, table, type_="foreignkey")
            except Exception:
                pass  # constraint already gone
        op.create_foreign_key(new_name, table, ref_table, [col], [ref_col], ondelete="CASCADE")
```

Or use raw SQL with `IF EXISTS`:
```python
conn.execute(text(f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS "{old_name}"'))
```

---

## Issue 3: Pydantic field warning for `model_id`

### Error
```
Field "model_id" in DeviceOut has conflict with protected namespace "model_"
```

### Findings

**schemas.py** - `DeviceOut` class (line 337):
```python
class DeviceOut(DeviceBase):
    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None   # <-- triggers warning
    ports_per_row: Optional[int] = None
    total_ports:   Optional[int] = None

    class Config:
        from_attributes = True
```

**schemas.py** - `DeviceMetaUpdate` class (line 360):
```python
class DeviceMetaUpdate(BaseModel):
    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None   # <-- also triggers warning
    ignored:  Optional[bool] = None
```

**Root Cause**: Pydantic v2 reserves the `model_` prefix as a protected namespace for internal model methods and attributes (e.g., `model_dump()`, `model_validate()`, `model_fields`, etc.). Any user-defined field starting with `model_` triggers a warning because it could conflict with Pydantic's own methods.

The field `model_id` starts with `model_` and therefore triggers this warning. The field name itself is correct from a domain perspective (it references the `switch_models.id` foreign key in the database), but Pydantic flags it.

**Fix**: Override `protected_namespaces` in the model config to allow `model_` prefixed fields. Both `DeviceOut` and `DeviceMetaUpdate` need this. Since `DeviceOut` already has a `Config` inner class, update it:

```python
class DeviceOut(DeviceBase):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())
    # ... fields ...
```

For `DeviceMetaUpdate` (which has no Config class):
```python
class DeviceMetaUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    # ... fields ...
```

Note: `DeviceBase` also has a `model` field (plain string, not `model_`-prefixed) which is fine. But any class with a field name starting with `model_` needs `protected_namespaces=()` (empty tuple) to suppress the warning.

The `ConfigDict` import should be added at the top of `schemas.py`:
```python
from pydantic import BaseModel, ConfigDict, field_serializer, model_validator
```

Also check: `BulkDeviceMetaUpdate` does NOT have `model_id`, so it does not need this fix.

---

## Summary

| Issue | Root Cause | Severity | Fix Complexity |
|-------|-----------|----------|----------------|
| 1. Celery task not found | `celery_app.py` missing `include=["tasks"]` | **High** - scans don't work | One line change |
| 2. Migration 003 constraint drop | FK constraint name mismatch or missing FK on `ports` table | **Medium** - blocks fresh deploys | Add error handling or `IF EXISTS` in migration |
| 3. Pydantic `model_id` warning | Pydantic v2 reserves `model_` prefix | **Low** - warning only, no breakage | Add `protected_namespaces=()` to affected schemas |

Analysis file: `docs/SubAgent/CONTAINER_FIXES_ANALYSIS.md`
