# Ruff Lint Error Analysis -- Backend

**Date:** 2026-03-21
**Total Errors:** 140
**Auto-fixable:** 102 (with `--fix`) + 8 additional (with `--unsafe-fixes`)
**Manual review needed:** 30 errors

---

## 1. Error Summary by Code

| Code | Count | Description | Auto-fixable? |
|------|-------|-------------|---------------|
| I001 | 69 | Import block is un-sorted or un-formatted | Yes (`--fix`) |
| F401 | 32 | Imported but unused | Yes (`--fix`, some `--unsafe-fixes`) |
| E402 | 14 | Module level import not at top of file | No (structural) |
| E701 | 11 | Multiple statements on one line (colon) | No (manual) |
| E712 | 6 | Comparison to `True`/`False` (use identity) | No (manual, behavior-sensitive) |
| E702 | 5 | Multiple statements on one line (semicolon) | No (manual) |
| F841 | 2 | Local variable assigned but never used | No (manual review) |
| E401 | 1 | Multiple imports on one line | Yes (`--fix`) |
| E741 | 1 | Ambiguous variable name | No (manual) |

---

## 2. Auto-fixable Errors (102 total)

### I001 -- Import sorting (69 errors) -- SAFE to auto-fix

Running `ruff check backend/ --fix` will reorder import blocks per isort conventions. This is purely cosmetic and will not change runtime behavior.

### F401 -- Unused imports (32 errors) -- MOSTLY SAFE

Most are safe to remove. The 8 "hidden fixes" requiring `--unsafe-fixes` are likely re-exports or imports with side effects that ruff cannot confirm are unused.

**Caution:** Some F401 errors in alembic migrations (`004_jsonb_snapshot_columns.py`) import `sqlalchemy` and `JSONB` -- these may be referenced by Alembic's autogenerate or `op.` calls indirectly. Verify before removing.

### E401 -- Multiple imports on one line (1 error) -- SAFE to auto-fix

`import struct, zlib` in `tests/test_map_bg.py:28` -- will be split into two import lines.

---

## 3. Manual-Review Errors (38 total)

### E402 -- Module level import not at top of file (14 errors)

These imports are intentionally placed after code that modifies `sys.path` or `sys.modules`. Auto-fixing would break the code.

**Affected files:**
| File | Lines | Reason for late import |
|------|-------|----------------------|
| `celery_app.py` | 28 | Import after broker config setup |
| `snmp_scanner.py` | 416 | Import after module body (circular dep avoidance) |
| `tests/conftest.py` | 19-28 (10 errors) | Imports after JSONB patch and MagicMock stubbing of modules |
| `tests/test_dns.py` | 12 | Import after `sys.modules` cleanup for real module loading |
| `tests/test_ping.py` | 11 | Import after `sys.modules` cleanup for real module loading |

**Recommendation:** Add `# noqa: E402` comments to suppress these. They are all intentional.

### E701 -- Multiple statements on one line: colon (11 errors)

All in `snmp_scanner.py`. Two patterns:

**Pattern 1 -- `speed_label()` function (lines 434-439):**
```python
if mbps >= 100_000: return "100G"
if mbps >= 40_000:  return "40G"
# ... etc
```
This is a compact lookup-table style. Expanding to multi-line is safe but reduces readability of this specific pattern. Could alternatively be refactored to a dict lookup.

**Pattern 2 -- Guard clauses with `continue` (lines 629, 634, 642, 650, 676):**
```python
if idx is None: continue
```
Simple guard clauses. Expanding to two lines is safe and mechanical.

**Recommendation:** Fix all 11. The speed_label function could use a dict-based approach or multi-line if/return blocks.

### E702 -- Multiple statements on one line: semicolon (5 errors)

All in `seed_db.py` (lines 271, 291, 311, 331, 351):
```python
db.add(fs1); db.flush()
```
Pattern: `db.add(X); db.flush()` for creating and immediately flushing seed objects.

**Recommendation:** Split into two lines. Purely stylistic, no behavior change.

### E712 -- Comparison to `True`/`False` (6 errors) -- BEHAVIOR-SENSITIVE

These use `==` comparisons in SQLAlchemy filter expressions. This is a case where the "pythonic" fix (`is True` / `not x`) would **BREAK** the code.

| File | Line | Expression |
|------|------|------------|
| `routers/auth.py` | 27 | `User.is_active == True` |
| `routers/auth.py` | 93 | `User.is_active == True` |
| `routers/topology.py` | 93 | `Device.ignored == False` |
| `scan_engine/executor.py` | 53 | `Device.ignored == False` |
| `scan_engine/executor.py` | 55 | `Credential.enabled == True` |
| `scan_engine/executor.py` | 59 | `Credential.enabled == True` |

**CRITICAL:** In SQLAlchemy, `Model.column == True` generates SQL `WHERE column = TRUE`. Changing to `Model.column is True` would evaluate the Python identity check on a `Column` object (always truthy) and silently return all rows instead of filtered results. This would be a **security and correctness bug**.

**Recommendation:** Suppress with `# noqa: E712` on each line. Alternatively, use SQLAlchemy's `.is_(True)` / `.is_(False)` methods:
```python
User.is_active.is_(True)
Device.ignored.is_(False)
```
This is both lint-clean and generates correct SQL.

### F841 -- Local variable assigned but never used (2 errors)

| File | Line | Variable | Analysis |
|------|------|----------|----------|
| `alembic/versions/003_add_cascade_deletes.py` | 52 | `conn` | `conn = op.get_bind()` in `downgrade()` -- the connection is obtained but not used. The `op.drop_constraint` / `op.create_foreign_key` calls don't need it. **Safe to remove.** |
| `scan_engine/executor.py` | 614 | `new_port_objects` | Assigned as `new_port_objects = []` but never populated or read. Likely leftover from a refactor. **Safe to remove.** |

### E741 -- Ambiguous variable name (1 error)

| File | Line | Variable | Context |
|------|------|----------|---------|
| `scan_engine/event_loop.py` | 20 | `l` | Used as parameter name: `def _run(l: asyncio.AbstractEventLoop)` |

The variable `l` (lowercase L) is ambiguous because it looks like `1` (one) in many fonts. 

**Recommendation:** Rename to `loop` -- the outer scope already has a `loop` variable, but `_run` is an inner function passed `loop` as an argument, so the parameter can be renamed independently:
```python
def _run(event_loop: asyncio.AbstractEventLoop):
    asyncio.set_event_loop(event_loop)
    event_loop.run_forever()
```

---

## 4. Affected Files -- Complete List

### Files with I001 only (import sorting -- safe auto-fix):
- `alembic/env.py`
- `alembic/versions/001_initial_schema.py`
- `alembic/versions/002_add_device_ignored.py`
- `alembic/versions/003b_add_switch_class_allow_outside_rack.py`
- `alembic/versions/006_add_users_table.py`
- `alembic/versions/007_add_audit_log.py`
- `alembic/versions/008_credential_fallback.py`
- `alembic/versions/009_dry_run_results.py`
- `alembic/versions/010_dry_run_cascade.py`
- `alembic/versions/011_add_tagged_vlans.py`
- `alembic/versions/012_consolidate_credential_device.py`
- `alembic/versions/013_separate_endpoints.py`
- `database.py`
- `routers/audit.py`
- `routers/bulk.py`
- `routers/config.py`
- `routers/credentials.py`
- `routers/racks.py`
- `routers/scan.py`
- `routers/snmp_profiles.py`
- `routers/switch_classes.py`
- `routers/switch_models.py`
- `scan_engine/__init__.py`
- `scan_engine/jobs.py`
- `scan_engine/scheduler.py` (x2 blocks)
- `shared/auth.py`
- `shared/metrics.py`
- `tests/test_bulk.py`
- `tests/test_config.py`
- `tests/test_health.py`
- `tests/test_scan_jobs.py`
- `tests/test_scanners.py`
- `tests/test_schemas.py`

### Files with multiple error types:
- `main.py` -- I001, F401
- `schemas.py` -- I001, F401
- `seed_db.py` -- I001 (x2), F401 (x3), E702 (x5)
- `snmp_scanner.py` -- I001, F401 (x2), E402, E701 (x11)
- `celery_app.py` -- I001, E402
- `tasks.py` -- I001 (x2)
- `scan_engine/event_loop.py` -- E741
- `scan_engine/executor.py` -- I001, F401 (x5), E712 (x3), F841
- `routers/auth.py` -- I001, E712 (x2)
- `routers/endpoints.py` -- I001, F401
- `routers/map_bg.py` -- I001, F401
- `routers/scan_settings.py` -- I001, F401
- `routers/settings.py` -- I001, F401
- `routers/topology.py` -- I001, F401 (x2), E712
- `routers/ws.py` -- I001, F401
- `shared/state.py` -- F401
- `alembic/versions/003_add_cascade_deletes.py` -- I001, F841
- `alembic/versions/004_jsonb_snapshot_columns.py` -- I001, F401 (x2)
- `tests/conftest.py` -- I001 (x2), E402 (x10)
- `tests/test_audit.py` -- I001, F401
- `tests/test_auth.py` -- I001 (x3), F401 (x2)
- `tests/test_config_module.py` -- F401
- `tests/test_db_helpers.py` -- I001, F401
- `tests/test_dns.py` -- I001 (x2), F401, E402
- `tests/test_map_bg.py` -- I001 (x3), F401 (x2), E401
- `tests/test_ping.py` -- I001 (x2), E402
- `tests/test_token_revocation.py` -- I001, F401
- `tests/test_topology.py` -- I001, F401
- `tests/test_websocket.py` -- I001 (x2)

---

## 5. pyproject.toml Configuration

Current ruff config in `backend/pyproject.toml`:

```toml
[tool.ruff]
line-length = 120
target-version = "py312"

[tool.ruff.lint]
select = ["E", "W", "F", "I"]
ignore = ["E501"]
```

No `ruff.toml` file exists. The config is reasonable:
- Selects Error, Warning, Pyflakes, and isort rules
- Ignores E501 (line too long) since `line-length = 120` handles that

**Suggested additions to `ignore`:**
```toml
ignore = ["E501"]

[tool.ruff.lint.per-file-ignores]
"alembic/versions/*.py" = ["E402"]
"tests/conftest.py" = ["E402"]
"tests/test_dns.py" = ["E402"]
"tests/test_ping.py" = ["E402"]
"celery_app.py" = ["E402"]
"snmp_scanner.py" = ["E402"]
```

This would suppress the 14 E402 errors that are intentional late imports, reducing the manual burden.

---

## 6. Recommended Fix Strategy

### Phase 1 -- Auto-fix (102 errors)
```bash
ruff check backend/ --fix
```
This handles all I001, most F401, and the E401 error. Run tests after to confirm nothing breaks.

### Phase 2 -- Manual fixes (8 errors)
1. **E741** (1): Rename `l` to `event_loop` in `scan_engine/event_loop.py:20`
2. **F841** (2): Remove unused `conn` and `new_port_objects` assignments
3. **E702** (5): Split semicolon-separated statements in `seed_db.py`

### Phase 3 -- E712 SQLAlchemy comparisons (6 errors)
Replace `== True` / `== False` with `.is_(True)` / `.is_(False)`:
- `routers/auth.py` lines 27, 93
- `routers/topology.py` line 93
- `scan_engine/executor.py` lines 53, 55, 59

### Phase 4 -- E701 style fixes (11 errors)
Expand single-line if statements in `snmp_scanner.py` to multi-line.

### Phase 5 -- E402 suppression (14 errors)
Add `per-file-ignores` to `pyproject.toml` for intentional late imports.

### Phase 6 -- Verify
```bash
ruff check backend/
# Should return 0 errors
python -m pytest backend/tests/
# Should pass all tests
```

---

## 7. Risk Assessment

| Fix Type | Risk | Notes |
|----------|------|-------|
| I001 (import sort) | None | Cosmetic only |
| F401 (unused imports) | Low | Verify alembic migration imports |
| E401 (multi-import) | None | Cosmetic only |
| E701 (inline if) | None | Cosmetic only |
| E702 (semicolon) | None | Cosmetic only |
| E741 (ambiguous name) | None | Simple rename |
| F841 (unused var) | None | Dead code removal |
| E712 (== True/False) | **HIGH if done wrong** | Must use `.is_(True)` not `is True` |
| E402 (late import) | **HIGH if auto-fixed** | Must suppress, not move imports |
