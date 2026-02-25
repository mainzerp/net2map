# Analysis: Support Outside-Rack Placement for Selected Switch Classes

## Scope
Add support so devices of selected switch classes can be placed outside racks and still participate in map/topology UX.

This is a **research/spec only** document (no implementation).

---

## 1) Current state (what exists now)

### 1.1 Switch class properties: where stored
- Backend ORM: `backend/database.py`
  - `SwitchClass` has: `id`, `label`, `description`, `color`, timestamps.
  - No property exists for outside-rack eligibility.
- API schemas: `backend/schemas.py`
  - `SwitchClassBase/Create/Update/Out` expose only `label`, `description`, `color`.
- API routes: `backend/routers/switch_classes.py`
  - Standard CRUD for class entities only.
- DB migration baseline: `backend/alembic/versions/001_initial_schema.py`
  - `switch_classes` table has no outside-rack boolean column.

### 1.2 Rack assignment: where enforced vs assumed
- Data model allows unracked devices:
  - `Device.rack_id` and `Credential.rack_id` are nullable (`backend/database.py`).
- Device metadata endpoint allows unassigning rack:
  - `PATCH /api/topology/devices/{id}/meta` accepts `rack_id: null` (`backend/routers/topology.py`).
- **Map rendering assumes rack assignment is required for visibility**:
  - `frontend/src/pages/MapPage.jsx`: comments and logic only build rack groups from `rack_id`.
  - `frontend/src/components/map/TopologyMap.jsx`: unracked nodes are excluded in `racks`, `ipToRackId`, and rack-link grouping.
- Settings tabs can unassign racks today:
  - `frontend/src/components/settings/RacksTab.jsx` uses `rack_id: null` via device meta patch.
- Class assignment is independent:
  - `class_id` can be set without `rack_id` in backend.

### 1.3 Persistence/sync behavior that affects placement
- Scan engine copies credential rack/class to devices (`backend/scan_engine.py`) but only when credential fields are non-null.
  - If credential has `rack_id`, scans can re-apply rack assignment.
- Credentials update endpoint currently uses `exclude_none=True` when applying updates (`backend/routers/credentials.py`), so explicit `null` from client does not reliably clear stored `rack_id` / `class_id` in credential rows.
- Result: outside-rack placement can drift/revert depending on credential values.

---

## 2) Gap analysis for requested feature

Requested feature implies two capabilities:
1. Mark **selected switch classes** as eligible for outside-rack placement.
2. Devices in those classes with `rack_id = null` must still be visible/placeable on map.

Current blockers:
- No class-level flag exists to represent eligibility.
- Map drops all unracked devices, regardless of class.
- Persistence path between device meta edits and credential-driven scan sync is inconsistent.

---

## 3) Exact required changes

## 3.1 Database / migrations
1. Add boolean column to `switch_classes`:
   - Name: `allow_outside_rack`
   - Type: `BOOLEAN NOT NULL`
   - Default: `false` (server default in migration)
2. New Alembic revision after `002_add_device_ignored.py`.
3. Update ORM model in `backend/database.py`.

Why needed: class-level policy must be persisted centrally and returned in topology payload.

---

## 3.2 Backend schemas / API / routes

### A) Switch class schemas + CRUD
- Extend in `backend/schemas.py`:
  - `SwitchClassBase`, `SwitchClassCreate`, `SwitchClassUpdate`, `SwitchClassOut` with `allow_outside_rack`.
- `backend/routers/switch_classes.py` requires no structural change beyond handling the new field (already generic set/update pattern).

### B) Device meta validation for rack/class consistency
- In `backend/routers/topology.py` (`update_device_meta`):
  - Validate that `rack_id = null` is accepted only when effective class allows outside-rack placement.
  - Effective class = payload `class_id` if provided, else current device class.
  - If class is null or class does not allow outside-rack, reject unrack operation (HTTP 400) with clear message.

### C) Credential/device sync consistency
- In `backend/routers/credentials.py` (`update_credential`):
  - Use `exclude_unset=True` instead of `exclude_none=True` so explicit null can clear `rack_id`/`class_id`.
  - Keep downstream device update behavior aligned with submitted payload.
- In `backend/scan_engine.py`:
  - Ensure scan-time sync does not unintentionally re-rack a device that was intentionally placed outside according to class policy.
  - Minimum requirement: deterministic rule documented and enforced (credential as source-of-truth or device meta as source-of-truth), not mixed behavior.

### D) Topology output contract
- `GET /api/topology` already returns `classes`; once schemas/model are updated, frontend receives `allow_outside_rack` automatically.

---

## 3.3 Frontend settings UI

### A) Switch classes tab
- File: `frontend/src/components/settings/SwitchClassesTab.jsx`
- Add an editable control for class policy:
  - `Allow outside rack placement` (boolean).
- Include this value in create/update payload.
- Show status badge in class cards for quick visibility.

### B) UX constraints in assignment flows
- Files:
  - `frontend/src/components/settings/RacksTab.jsx`
  - `frontend/src/components/settings/CredentialsTab.jsx`
- Prevent invalid combinations in UI where possible:
  - If class disallows outside, do not allow ending with `rack_id = null`.
  - If user clears rack, require/keep a class that allows outside.

---

## 3.4 Map placement behavior

Files:
- `frontend/src/pages/MapPage.jsx`
- `frontend/src/components/map/TopologyMap.jsx`
- `frontend/src/components/map/FilterBar.jsx`
- (Potentially) `frontend/src/components/map/RackDetail.jsx`

Required behavior:
1. Devices with `rack_id = null` and class where `allow_outside_rack = true` must be rendered on map.
2. They must remain draggable using existing `map_x`/`map_y` persistence (`PATCH /api/topology/devices/{id}/position`).
3. Link rendering must include rack↔outside and outside↔outside relations where applicable.
4. Filtering must be predictable:
   - Class filter applies to outside-rack devices naturally.
   - Rack filter should define how outside devices are treated (recommended: separate “Outside” target or unaffected by rack filter).

Implementation shape options (to decide during planning):
- **Option 1 (recommended):** render outside-rack devices as standalone nodes (not pseudo-racks).
- **Option 2:** group by class into synthetic outside clusters.

Option 1 is simpler and less coupled to rack-detail assumptions.

---

## 4) Non-obvious side effects to account for
- Existing comments and logic explicitly state unracked nodes are hidden in map files; these assumptions must be removed.
- `CredentialsTab` currently can present “no rack”, but backend update semantics for null are inconsistent; fix is required for reliable outside placement.
- Scan sync behavior must not silently undo outside placement.

---

## 5) Key files that must change

### Backend
- `backend/alembic/versions/<new_revision>_add_switch_class_allow_outside_rack.py` (new)
- `backend/database.py`
- `backend/schemas.py`
- `backend/routers/switch_classes.py`
- `backend/routers/topology.py`
- `backend/routers/credentials.py`
- `backend/scan_engine.py`

### Frontend
- `frontend/src/components/settings/SwitchClassesTab.jsx`
- `frontend/src/components/settings/CredentialsTab.jsx`
- `frontend/src/components/map/TopologyMap.jsx`
- `frontend/src/pages/MapPage.jsx`
- `frontend/src/components/map/FilterBar.jsx`
- `frontend/src/components/map/RackDetail.jsx` (if outside nodes need panel-level support)

---

## 6) Recommended acceptance criteria (for planning)
1. Switch class has a persisted `allow_outside_rack` property editable in Settings.
2. Device with class allowed + `rack_id=null` remains visible and movable on map.
3. Device with class disallowed cannot be left unracked via API/UI.
4. After a scan run, valid outside-rack placement is preserved (no unintended rerack).
5. Topology links continue to render correctly for mixed rack/outside endpoints.
