# Analysis: Enable Outside-Rack Device Detail Selection

## Scope
Enable outside-rack devices (`allow_outside_rack=true` class + `rack_id=null`) to be selectable from the topology map and open the existing detail panel so users can inspect individual ports.

This document is research/spec only. No implementation is included.

---

## 1) Current Selection/Detail Flow

## 1.1 Map page selection state
File: `frontend/src/pages/MapPage.jsx`

- `MapPage` stores selected detail as `selectedRack` (from `useTopologyData`), plus `selectedLink`.
- `handleSelectRack` toggles rack selection and clears `selectedLink`.
- Right panel renders only when `selectedRackFull` exists.
- `selectedRackFull` is derived by:
  - reading `selectedRack.id` as rack id,
  - filtering `topology.nodes` by `node.rack_id === selectedRack.id`.
- This derivation only works for real racks, not outside devices.

## 1.2 Map interaction and click handling
File: `frontend/src/components/map/TopologyMap.jsx`

- Racks are clickable/draggable:
  - mouse down starts drag (`kind: "rack"`),
  - mouse up without movement triggers `onSelectRack(rack)`.
- Outside devices are rendered and draggable (`kind: "outside"`), but:
  - mouse up only persists position if moved,
  - there is no click path to open details.
- Result: outside nodes are visible and movable, but never selectable for panel details.

## 1.3 Detail panel behavior
File: `frontend/src/components/map/RackDetail.jsx`

- Panel is generic enough to render a single device if provided as `rack.devices=[device]`.
- Port rendering, link highlighting, and connection lists already work from `topologyLinks` + device ports.
- The header currently includes rack rename affordance and assumes rack semantics unless guarded.

## 1.4 Hooks involved

### `frontend/src/hooks/useTopologyData.js`
- Owns `selectedRack` + session persistence (`selectedRackId` in `sessionStorage`).
- Restore logic parses saved id as number and resolves only actual racks.
- Outside selection is not modeled.

### `frontend/src/hooks/useRackOrders.js`
- Order storage is keyed by `{rackId}::{groupKey}`.
- Works for any stable key; no backend dependency.

### `frontend/src/hooks/useMapBackground.js`
- Visual background only; no selection logic impact.

---

## 2) Backend Impact

Reviewed:
- `backend/routers/topology.py`
- `backend/schemas.py`
- `backend/routers/switch_classes.py`
- `backend/database.py`

Findings:
- Backend already returns all required data in `/api/topology`:
  - `nodes` include `rack_id`, `class_id`, ports.
  - `classes` include `allow_outside_rack`.
- Outside-rack policy enforcement already exists in `PATCH /api/topology/devices/{id}/meta`.
- No API contract change is required for selection/detail behavior.

Conclusion: backend changes are not required for this task.

---

## 3) Minimal UX/Technical Design

Design goal: reuse existing UI and panel with the smallest possible delta.

## 3.1 UX

- Clicking an outside device behaves like clicking a rack:
  - opens right-side detail panel (same `RackDetail` component),
  - clears selected cable link on selection switch,
  - click same outside node again toggles panel closed.
- Drag behavior remains unchanged:
  - drag moves device,
  - click (no movement) selects detail.
- No new pages, modals, or controls.

## 3.2 Technical shape (minimal)

1. Introduce a selection model in `MapPage` that supports both:
   - rack selection,
   - outside-device selection.
2. Build a pseudo detail object for outside device selection:
   - `id`: stable outside key (e.g., `outside:<deviceId>`),
   - `label`: `sys_name || ip`,
   - `location`: static outside marker label,
   - `devices`: single selected node.
3. Extend `TopologyMap` API with outside selection callbacks/ids:
   - `onSelectOutside(node)`
   - `selectedOutsideId`
4. On outside node mouse up with no movement, call `onSelectOutside(node)`.
5. Guard rack-only actions in `RackDetail` usage:
   - disable/hide rename for outside pseudo selection.

Notes:
- Port detail behavior should work without backend changes because `RackDetail` operates on provided devices and topology links.
- `useRackOrders` remains valid because keys are string-safe.

---

## 4) Exact Files to Change

Primary:
1. `frontend/src/pages/MapPage.jsx`
2. `frontend/src/components/map/TopologyMap.jsx`

Likely (small UX guard for rack-only actions):
3. `frontend/src/components/map/RackDetail.jsx`

Optional (only if outside selection must persist across reload like rack selection):
4. `frontend/src/hooks/useTopologyData.js`

No backend files required.

---

## 5) Acceptance Criteria

1. Outside-rack node click opens right detail panel with that device’s ports.
2. Outside-rack node second click closes the panel (toggle behavior consistent with rack).
3. Dragging outside-rack node still persists position and does not unintentionally open details.
4. Existing rack selection/detail flow remains unchanged.
5. No new API endpoints or schema changes.
