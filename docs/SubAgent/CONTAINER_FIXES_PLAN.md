# Container Fixes - Implementation Plan

Based on analysis: `docs/SubAgent/CONTAINER_FIXES_ANALYSIS.md`

---

## Fix 1: Celery Task Registration

### File
`backend/celery_app.py`

### Problem
The Celery worker starts with `-A celery_app`, which loads `celery_app.py` but never imports `tasks.py`. The `@celery_app.task` decorator in `tasks.py` never fires in the worker process, so `tasks.run_scan_task` is unregistered and raises `KeyError`.

### Change

**Find (line 9):**
```python
celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL)
```

**Replace with:**
```python
celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL, include=["tasks"])
```

### Verification
- [ ] Run `docker compose up -d --build celery-worker`
- [ ] Check worker logs: `docker compose logs celery-worker` -- should show `tasks.run_scan_task` in the registered task list
- [ ] Trigger a scan from the UI or API and confirm it executes without `KeyError: 'tasks.run_scan_task'`

---

## Fix 2: Migration 003 Robustness

### File
`backend/alembic/versions/003_add_cascade_deletes.py`

### Problem
`op.drop_constraint(old_name, table, type_="foreignkey")` fails with `constraint "X" does not exist` when the introspected name does not match an actual constraint in the database (stale metadata, partial prior run, or schema created via `create_all()`).

### Change

**Find (lines 43-48, the `upgrade` function):**
```python
def upgrade() -> None:
    conn = op.get_bind()
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        old_name = _find_fk_name(conn, table, col, ref_table)
        if old_name:
            op.drop_constraint(old_name, table, type_="foreignkey")
        op.create_foreign_key(new_name, table, ref_table, [col], [ref_col], ondelete="CASCADE")
```

**Replace with:**
```python
def upgrade() -> None:
    conn = op.get_bind()
    for table, col, ref_table, ref_col, new_name in _FK_SPECS:
        old_name = _find_fk_name(conn, table, col, ref_table)
        if old_name:
            conn.execute(text(
                f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS "{old_name}"'
            ))
        op.create_foreign_key(new_name, table, ref_table, [col], [ref_col], ondelete="CASCADE")
```

**Why raw SQL instead of try/except:** `DROP CONSTRAINT IF EXISTS` is a single atomic PostgreSQL statement that cleanly no-ops when the constraint is missing, without polluting logs with exception tracebacks. The `text` import already exists at line 4 of the file.

### Verification
- [ ] Run migrations on a fresh database: `docker compose exec backend alembic upgrade head` -- should complete with no errors
- [ ] Run migrations again (idempotency check): `alembic upgrade head` -- should report "already at head" with no constraint errors
- [ ] Verify FK constraints exist: connect to the DB and run `SELECT conname FROM pg_constraint WHERE conrelid = 'ports'::regclass AND contype = 'f';` -- should show `fk_ports_device_id`

---

## Fix 3: Pydantic protected_namespaces

### File
`backend/schemas.py`

### Problem
Pydantic v2 reserves the `model_` prefix for internal methods (`model_dump()`, `model_validate()`, etc.). The field `model_id` in `DeviceOut` and `DeviceMetaUpdate` triggers a warning: `Field "model_id" has conflict with protected namespace "model_"`.

### Changes (3 edits in schemas.py)

#### 3a. Add `ConfigDict` to the import

**Find (line 4):**
```python
from pydantic import BaseModel, field_serializer, model_validator
```

**Replace with:**
```python
from pydantic import BaseModel, ConfigDict, field_serializer, model_validator
```

#### 3b. Update `DeviceOut` to use `model_config`

**Find (lines 337-349):**
```python
class DeviceOut(DeviceBase):
    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    ports_per_row: Optional[int] = None   # resolved from switch_model
    total_ports:   Optional[int] = None   # port cutoff: ports beyond this index are hidden

    class Config:
        from_attributes = True
```

**Replace with:**
```python
class DeviceOut(DeviceBase):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    ports_per_row: Optional[int] = None   # resolved from switch_model
    total_ports:   Optional[int] = None   # port cutoff: ports beyond this index are hidden
```

This replaces the legacy `class Config` inner class with the Pydantic v2 `model_config` attribute and adds `protected_namespaces=()` to allow `model_` prefixed fields.

#### 3c. Add `model_config` to `DeviceMetaUpdate`

**Find (lines 360-368):**
```python
class DeviceMetaUpdate(BaseModel):
    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
    ignored:  Optional[bool] = None
```

**Replace with:**
```python
class DeviceMetaUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
    ignored:  Optional[bool] = None
```

### Verification
- [ ] Start the backend: `docker compose up -d --build backend` -- no Pydantic warnings about `model_id` in the logs
- [ ] Run existing tests: `cd backend && python -m pytest tests/test_schemas.py -v` -- all pass
- [ ] Verify API response: `GET /api/devices` returns devices with `model_id` field populated correctly

---

## Implementation Checklist

| # | Fix | File | Status |
|---|-----|------|--------|
| 1 | Celery `include=["tasks"]` | `backend/celery_app.py` | [ ] |
| 2 | Migration 003 `IF EXISTS` | `backend/alembic/versions/003_add_cascade_deletes.py` | [ ] |
| 3a | Import `ConfigDict` | `backend/schemas.py` (line 4) | [ ] |
| 3b | `DeviceOut` model_config | `backend/schemas.py` (line 337) | [ ] |
| 3c | `DeviceMetaUpdate` model_config | `backend/schemas.py` (line 360) | [ ] |

## Post-Implementation Verification

1. Rebuild all containers: `docker compose up -d --build`
2. Check backend logs for Pydantic warnings: `docker compose logs backend | grep -i "protected_namespace\|model_"`
3. Check celery-worker logs for task registration: `docker compose logs celery-worker | grep "run_scan_task"`
4. Run a scan to confirm end-to-end flow
5. If the database is fresh, confirm migrations run cleanly: `docker compose exec backend alembic upgrade head`
