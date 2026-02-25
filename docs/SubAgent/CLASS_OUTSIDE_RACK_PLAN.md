# Implementation Plan: Class-Based Outside-Rack Placement

**Date:** 2026-02-25
**Based on:** `docs/SubAgent/CLASS_OUTSIDE_RACK_ANALYSIS.md`
**Scope:** Planning only (no implementation in this document)

---

## Objectives

1. Add a class-level policy to allow devices of selected switch classes to exist outside racks.
2. Keep outside-rack devices visible and movable on the topology map when policy allows.
3. Prevent invalid rack/class combinations at API and UI level.
4. Preserve valid outside-rack assignments across credential updates and scan/sync cycles.

---

## Non-Goals

- No redesign of rack details UX beyond what is needed to support outside-rack visibility.
- No new topology entity types (e.g., no new DB table for outside groups).
- No unrelated refactoring outside listed files.

---

## Phase 1 — Data Model & Alembic Migration

### 1.1 Add class policy column
- [ ] Add `allow_outside_rack` to `SwitchClass` ORM model in `backend/database.py`.
- [ ] Column spec: `Boolean`, `nullable=False`, ORM default `False`.

### 1.2 Create Alembic revision
- [ ] Create new migration file in `backend/alembic/versions/` (next revision after `002`, recommended id `003`).
- [ ] Set `down_revision = "002"`.
- [ ] In `upgrade()`, add `switch_classes.allow_outside_rack` with `server_default="false"`, `nullable=False`.
- [ ] In `downgrade()`, drop the column.

### 1.3 Existing DB strategy (PostgreSQL + migrated environments)
- [ ] Keep migration additive and backward-compatible for existing rows (`false` backfill via server default).
- [ ] After column creation, remove server default in same migration if the project prefers app-level defaults only.
- [ ] Validate migration on:
  - [ ] Existing PostgreSQL DB already at `002`.
  - [ ] Fresh DB bootstrap (`alembic upgrade head`).
- [ ] Confirm no special SQLite path is required (project now runs on PostgreSQL; SQLite handled only by external migration script workflow).

Deliverable: schema can represent class-level outside-rack eligibility for all environments.

---

## Phase 2 — Backend Schemas & CRUD Contract

### 2.1 Extend Pydantic schemas
- [ ] Add `allow_outside_rack` to:
  - [ ] `SwitchClassBase`
  - [ ] `SwitchClassCreate`
  - [ ] `SwitchClassUpdate`
  - [ ] `SwitchClassOut`
- [ ] `SwitchClassUpdate.allow_outside_rack` should be `Optional[bool]`.

### 2.2 Preserve null/false update semantics
- [ ] Ensure update payload handling uses `exclude_unset=True` for partial updates where explicit `null`/`false` are meaningful.
- [ ] For `switch_classes` route, verify `false` can be persisted correctly when toggled off.

Deliverable: backend contracts expose and persist class outside-rack policy cleanly.

---

## Phase 3 — Backend Validation Rules for Rack/Class Consistency

### 3.1 Device meta guardrails (`PATCH /api/topology/devices/{id}/meta`)
- [ ] Add effective-class validation in `backend/routers/topology.py`.
- [ ] Compute effective class as:
  - payload `class_id` if provided, else current `device.class_id`.
- [ ] If resulting `rack_id` is `null`, require effective class with `allow_outside_rack=True`.
- [ ] Return `HTTP 400` with clear message for invalid combinations.
- [ ] Keep existing `404` checks for unknown class/rack/model IDs.

### 3.2 Credential update consistency (`PUT /api/credentials/{id}`)
- [ ] Switch credential update field extraction to `exclude_unset=True` so explicit `null` clears are honored.
- [ ] Reuse payload once (avoid repeated `model_dump` calls).
- [ ] Apply same rack/class validity guard when credential update would set/clear rack/class in an invalid way.

### 3.3 Optional hardening on class changes
- [ ] On switch class update (`allow_outside_rack: false`), decide deterministic behavior for currently unracked devices in that class:
  - [ ] Preferred: reject toggle with `409` if incompatible devices exist, forcing user remediation first.
  - [ ] Alternative: auto-rack is not recommended (implicit behavior).
- [ ] Document chosen behavior in API response message and release notes.

Deliverable: API enforces valid state transitions, not just UI conventions.

---

## Phase 4 — Scan/Sync Persistence Safeguards

### 4.1 Define source-of-truth rule
- [ ] Document and implement one consistent rule for `rack_id`/`class_id` synchronization between credentials and devices.
- [ ] Recommended rule: explicit credential assignments remain authoritative only when fields are present in credential payload updates.

### 4.2 Prevent silent rerack during scans
- [ ] In `backend/scan_engine.py`, ensure sync logic does not reapply invalid rack/class states.
- [ ] Before applying `cred.rack_id`/`cred.class_id` to device, validate against class policy.
- [ ] If invalid, keep device unchanged and log a structured warning event.

### 4.3 Preserve intentional outside placements
- [ ] Ensure devices legitimately outside rack (`rack_id=null`, class allows) remain so after:
  - [ ] full scan
  - [ ] ports scan
  - [ ] links scan
  - [ ] macs scan

Deliverable: scan engine cannot unintentionally undo valid outside-rack placements.

---

## Phase 5 — Frontend Settings: SwitchClasses UI

### 5.1 Add policy control in `SwitchClassesTab.jsx`
- [ ] Extend form state with `allow_outside_rack`.
- [ ] Add explicit control label: `Allow outside rack placement`.
- [ ] Include field in create/update API payloads.
- [ ] On edit, prefill current value correctly.

### 5.2 Improve class card visibility
- [ ] Add compact status indicator on each class card (`Outside allowed` / `Rack required`).
- [ ] Keep current styling primitives and existing inline-style pattern.

### 5.3 Assignment UX safety
- [ ] For class/device assignment flows in settings tabs, prevent ending in invalid state where possible.
- [ ] If backend rejects, surface actionable error text and keep user selection intact.

Deliverable: admins can manage outside-rack eligibility directly in class settings.

---

## Phase 6 — Map Rendering & Placement for Outside-Rack Devices

### 6.1 Data shaping in `MapPage.jsx`
- [ ] Remove assumption that unracked nodes are always hidden.
- [ ] Build two render groups:
  - [ ] rack groups (existing behavior)
  - [ ] outside-rack nodes where class allows.
- [ ] Decide outside-rack rack-detail interaction behavior:
  - [ ] minimal approach: selectable on map, no rack panel dependency.

### 6.2 Rendering in `TopologyMap.jsx`
- [ ] Extend render pipeline to include outside nodes as standalone draggable map nodes.
- [ ] Keep existing drag persistence via `/api/topology/devices/{id}/position`.
- [ ] Keep rack drag behavior unchanged.
- [ ] Build `ip` mapping that supports mixed endpoint types:
  - [ ] rack-to-rack
  - [ ] rack-to-outside
  - [ ] outside-to-outside

### 6.3 Link and filter semantics
- [ ] Ensure link aggregation logic does not drop links when one/both endpoints are outside.
- [ ] Define rack-filter behavior for outside nodes (recommended: rack filter affects only rack groups; outside nodes remain controlled by class filter).
- [ ] Ensure class filters apply uniformly to both rack and outside nodes.
- [ ] Update `FilterBar.jsx` only as needed to reflect semantics without adding extra UI complexity.

### 6.4 Optional panel compatibility
- [ ] If any panel component assumes every visible device belongs to a rack, guard or branch logic to avoid runtime errors.

Deliverable: allowed outside-rack devices are visible, draggable, and fully linked on map.

---

## Phase 7 — API/Frontend Integration Checks

- [ ] Verify `/api/topology` payload includes class `allow_outside_rack` in `classes` array.
- [ ] Confirm frontend consumes this field without extra endpoint changes.
- [ ] Ensure ETag invalidation paths still refresh topology after class/device metadata updates.

Deliverable: end-to-end data flow for policy + placement is stable.

---

## Phase 8 — Validation & Test Matrix

### 8.1 Backend checks
- [ ] Run Alembic migration smoke test: `alembic upgrade head` and `alembic downgrade -1` in dev DB.
- [ ] API validation scenarios:
  - [ ] set `rack_id=null` with class allow=true → success.
  - [ ] set `rack_id=null` with class allow=false → 400.
  - [ ] clear class while unracked → 400.
  - [ ] credential update with explicit `rack_id: null` respected.

### 8.2 Scan/sync checks
- [ ] Run scan types (`full`, `ports`, `links`, `macs`) and verify no policy-breaking rerack occurs.
- [ ] Validate logs for rejected sync writes when invalid combinations are encountered.

### 8.3 Frontend checks
- [ ] SwitchClasses tab create/edit/toggle roundtrip.
- [ ] Map shows outside nodes only for eligible classes.
- [ ] Drag + refresh preserves outside node coordinates.
- [ ] Mixed links render correctly and filters remain predictable.

### 8.4 Regression checks
- [ ] Existing rack workflows continue to work.
- [ ] No regressions in rack detail panel for normal rack devices.

Deliverable: feature is validated functionally and against regressions.

---

## VERSION.md Update Guidance (SemVer)

### Recommended bump
- [ ] Bump **MINOR** version (e.g., `v1.5.0` -> `v1.6.0`).

### Rationale
- [ ] This is a backward-compatible new feature (new class capability + new map behavior), not just a bug fix.
- [ ] No breaking API removals are planned.

### Entry content checklist
- [ ] Add new top section with title (e.g., `v1.6.0 — Class-Based Outside-Rack Placement`).
- [ ] Mark type as `MINOR (new feature)`.
- [ ] Summarize backend migration/API validation additions.
- [ ] Summarize frontend SwitchClasses and map rendering changes.
- [ ] Include key modified files list.

---

## Definition of Done

- [ ] DB schema supports class outside-rack policy.
- [ ] API blocks invalid unracked states and allows valid ones.
- [ ] Scan/sync does not undo valid outside placements.
- [ ] SwitchClasses settings can manage policy.
- [ ] Map renders + persists outside-rack eligible devices and their links.
- [ ] Validation matrix passes.
- [ ] `VERSION.md` updated with MINOR release note.
