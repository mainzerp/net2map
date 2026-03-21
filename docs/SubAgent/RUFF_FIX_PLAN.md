# Ruff Lint Fix -- Implementation Plan

**Date:** 2026-03-21
**Goal:** Fix all 140 ruff lint errors so GitHub Actions CI passes
**Analysis:** [RUFF_FIX_ANALYSIS.md](RUFF_FIX_ANALYSIS.md)

---

## Phase 1: Configure per-file-ignores for E402 (14 errors)

Suppress intentional late imports before running auto-fix, so ruff does not attempt to move them.

- [ ] **1.1** Edit `backend/pyproject.toml` -- add `per-file-ignores` section:
  ```toml
  [tool.ruff.lint.per-file-ignores]
  "alembic/versions/*.py" = ["E402"]
  "tests/conftest.py" = ["E402"]
  "tests/test_dns.py" = ["E402"]
  "tests/test_ping.py" = ["E402"]
  "celery_app.py" = ["E402"]
  "snmp_scanner.py" = ["E402"]
  ```
  Append this after the existing `[tool.ruff.lint]` block.

---

## Phase 2: Auto-fix I001, F401, E401 (102 errors)

Run ruff auto-fix to handle import sorting, unused imports, and multi-import lines.

- [ ] **2.1** Run `ruff check backend/ --fix` from the repo root.
- [ ] **2.2** Review the diff, paying special attention to:
  - `alembic/versions/004_jsonb_snapshot_columns.py` -- confirm `sqlalchemy` and `JSONB` imports are not removed if referenced by Alembic `op.` calls.
  - `shared/state.py` -- confirm removed imports are not re-exports consumed by other modules.
- [ ] **2.3** If any F401 removals look wrong (re-exports or Alembic-needed imports), restore those lines and add `# noqa: F401` to suppress them.

---

## Phase 3: Fix E712 -- SQLAlchemy boolean comparisons (6 errors)

Replace `== True` / `== False` with SQLAlchemy `.is_(True)` / `.is_(False)`. Do NOT use Python `is True` -- that would silently break query filtering.

- [ ] **3.1** `backend/routers/auth.py` line 27:
  Change `User.is_active == True` to `User.is_active.is_(True)`
- [ ] **3.2** `backend/routers/auth.py` line 93:
  Change `User.is_active == True` to `User.is_active.is_(True)`
- [ ] **3.3** `backend/routers/topology.py` line 93:
  Change `Device.ignored == False` to `Device.ignored.is_(False)`
- [ ] **3.4** `backend/scan_engine/executor.py` line 53:
  Change `Device.ignored == False` to `Device.ignored.is_(False)`
- [ ] **3.5** `backend/scan_engine/executor.py` line 55:
  Change `Credential.enabled == True` to `Credential.enabled.is_(True)`
- [ ] **3.6** `backend/scan_engine/executor.py` line 59:
  Change `Credential.enabled == True` to `Credential.enabled.is_(True)`

---

## Phase 4: Fix E741 -- Ambiguous variable name (1 error)

- [ ] **4.1** `backend/scan_engine/event_loop.py` line 20:
  Rename parameter `l` to `event_loop` in the `_run` function signature and all references within `_run`:
  ```python
  # Before
  def _run(l: asyncio.AbstractEventLoop):
      asyncio.set_event_loop(l)
      l.run_forever()

  # After
  def _run(event_loop: asyncio.AbstractEventLoop):
      asyncio.set_event_loop(event_loop)
      event_loop.run_forever()
  ```

---

## Phase 5: Fix F841 -- Unused variables (2 errors)

- [ ] **5.1** `backend/alembic/versions/003_add_cascade_deletes.py` line 52:
  Remove the line `conn = op.get_bind()` from `downgrade()`. It is unused.
- [ ] **5.2** `backend/scan_engine/executor.py` line 614:
  Remove the line `new_port_objects = []`. It is never populated or read.

---

## Phase 6: Fix E702 -- Semicolon-separated statements (5 errors)

Split `db.add(X); db.flush()` into two lines in `backend/seed_db.py`.

- [ ] **6.1** Line 271: Split `db.add(fs1); db.flush()` into:
  ```python
  db.add(fs1)
  db.flush()
  ```
- [ ] **6.2** Line 291: Split `db.add(fs2); db.flush()` (same pattern).
- [ ] **6.3** Line 311: Split `db.add(fs3); db.flush()` (same pattern).
- [ ] **6.4** Line 331: Split `db.add(fs4); db.flush()` (same pattern).
- [ ] **6.5** Line 351: Split `db.add(fs5); db.flush()` (same pattern).

---

## Phase 7: Fix E701 -- Single-line if statements (11 errors)

All in `backend/snmp_scanner.py`. Expand to multi-line.

### 7a: speed_label() function (lines 434-439, 6 errors)

- [ ] **7.1** Expand the compact if/return block. Each line like:
  ```python
  if mbps >= 100_000: return "100G"
  ```
  becomes:
  ```python
  if mbps >= 100_000:
      return "100G"
  ```
  Apply to all 6 lines in `speed_label()`.

### 7b: Guard clauses with continue (lines 629, 634, 642, 650, 676, 5 errors)

- [ ] **7.2** Expand each `if condition: continue` to:
  ```python
  if condition:
      continue
  ```
  Apply to all 5 occurrences.

---

## Phase 8: Verification

- [ ] **8.1** Run `ruff check backend/` -- expect **0 errors**.
- [ ] **8.2** If any errors remain, address them individually.
- [ ] **8.3** Run `python -m pytest backend/tests/ -x` -- confirm all tests pass.
- [ ] **8.4** Review the full diff one final time to confirm no behavioral changes were introduced (especially E712 and F401 fixes).

---

## Execution Order and Rationale

| Order | Phase | Errors Fixed | Why This Order |
|-------|-------|-------------|----------------|
| 1 | pyproject.toml config | 14 (E402) | Must suppress E402 before auto-fix to prevent ruff from moving late imports |
| 2 | Auto-fix | 102 (I001, F401, E401) | Bulk-fixes the majority of errors in one command |
| 3 | E712 SQLAlchemy | 6 | High-risk fix -- do early so it gets maximum test coverage |
| 4 | E741 rename | 1 | Simple rename, low risk |
| 5 | F841 unused vars | 2 | Dead code removal, low risk |
| 6 | E702 semicolons | 5 | Mechanical split, cosmetic only |
| 7 | E701 inline if | 11 | Mechanical expansion, cosmetic only |
| 8 | Verification | -- | Confirm zero lint errors and passing tests |

**Total: 140 errors resolved (14 suppressed via config, 102 auto-fixed, 24 manually fixed)**

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| F401 removes needed Alembic imports | Review diff in Phase 2.2; restore + `# noqa: F401` if needed |
| F401 removes re-exports | Review `shared/state.py` specifically; restore + `# noqa: F401` |
| E712 `.is_(True)` generates wrong SQL | This is documented SQLAlchemy API; generates `IS TRUE` which is equivalent to `= TRUE` |
| E741 rename breaks callers | `_run` is an inner function in `event_loop.py` -- parameter rename has no external impact |
| Auto-fix changes runtime behavior | Run full test suite in Phase 8.3 |
