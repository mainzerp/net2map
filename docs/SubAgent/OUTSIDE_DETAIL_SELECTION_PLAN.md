# Plan: Outside Node Detail Selection (Minimal UX)

## Objective
Enable outside-rack nodes (`rack_id=null` + class `allow_outside_rack=true`) to be selectable on the map and open the existing right-side detail panel so ports are visible, using the existing `RackDetail` flow with minimal changes.

## Constraints (Hard)
- Minimal UX only; no new pages/modals/components.
- Reuse `RackDetail` for outside detail rendering.
- Keep existing rack selection/drag/detail behavior intact.
- Outside drag behavior must remain unchanged (drag moves + persists, click selects).
- Frontend-only scope.

## Phase 1 — Selection Model in MapPage
- [ ] Add outside selection state in `frontend/src/pages/MapPage.jsx`.
- [ ] Keep rack selection (`selectedRack`) from `useTopologyData` unchanged for existing behavior.
- [ ] Add `handleSelectOutside(node)` that:
  - clears `selectedLink`,
  - clears rack selection (`setSelectedRack(null)`),
  - toggles selected outside node by `node.id`.
- [ ] Update `handleSelectRack(rack)` to also clear any outside selection when choosing a rack.

### Exact changes in frontend/src/pages/MapPage.jsx
- Add local state: `selectedOutsideNode` (or equivalent) keyed by device id/object.
- Keep existing `selectedRackFull` derivation for real racks.
- Add `selectedOutsideDetail` memo that builds a pseudo-rack object for `RackDetail`:
  - `id`: `outside:${node.id}`
  - `label`: `node.sys_name || node.ip`
  - `location`: `"Outside rack"`
  - `devices`: `[node]`
- Add a unified panel source (e.g., `selectedDetail = selectedRackFull || selectedOutsideDetail`).
- Pass new props into `TopologyMap`:
  - `onSelectOutside={handleSelectOutside}`
  - `selectedOutsideId={selectedOutsideNode?.id ?? null}`
- Keep `centerRackId` based only on rack selection.
- Render `RackDetail` when `selectedDetail` exists, passing:
  - `rack={selectedDetail}`
  - `onClose` that clears both rack and outside selection
  - rack rename callback only for real rack selection (guarded)
  - reorder handlers keyed by `selectedDetail.id` (works for string outside key)

## Phase 2 — Outside Click Selection in TopologyMap
- [ ] Extend `TopologyMap` props to support outside selection.
- [ ] Detect click-vs-drag for outside nodes using existing `drag.moved` flag.
- [ ] On outside mouse-up without movement, call outside selection callback.
- [ ] Preserve existing drag persistence behavior.

### Exact changes in frontend/src/components/map/TopologyMap.jsx
- Extend function signature with:
  - `onSelectOutside`
  - `selectedOutsideId`
- In `onMouseUp`:
  - keep existing rack behavior unchanged,
  - for `drag.kind === "outside"`:
    - if moved: persist position exactly as today,
    - if not moved: call `onSelectOutside?.(node)` (resolve node from `drag.nodeId`).
- Add selected visual state for outside nodes similar to rack highlight (minimal style delta only):
  - compute `isOutsideSelected = selectedOutsideId === node.id`
  - apply stronger stroke/glow on selected outside node.
- Do not add any new interactions beyond click select + existing drag.

## Phase 3 — RackDetail Guard for Rack-Only Actions
- [ ] Keep `RackDetail` reusable for both real racks and outside pseudo-rack.
- [ ] Guard rename affordance for non-rack selections.
- [ ] Keep ports/uplinks/trunks/inter-rack rendering untouched.

### Exact changes in frontend/src/components/map/RackDetail.jsx
- Add a minimal prop guard for rename visibility, one of:
  - `canRename` boolean prop, or
  - infer from `typeof onRename === "function"`.
- Conditionally render Edit/rename controls only when rename is allowed.
- Keep header title/location/port counts shown for outside detail.
- Keep all existing port interaction behavior unchanged.

## Phase 4 — Wiring and Regression Pass
- [ ] Verify prop wiring compiles cleanly after signature updates.
- [ ] Ensure no API contract changes and no backend edits.
- [ ] Confirm no additional components/pages/modals were introduced.

## Validation Checklist

### Manual validation
- [ ] Click a rack: existing rack detail opens exactly as before.
- [ ] Click same rack again: panel closes (existing toggle behavior preserved).
- [ ] Click an outside node: panel opens using `RackDetail` with that single device and visible ports.
- [ ] Click same outside node again: panel closes.
- [ ] Switch selection rack <-> outside: selected cable link clears in both directions.
- [ ] Drag outside node: position updates and persists; detail does not open on drag.
- [ ] Simple click outside node (no movement): detail opens.
- [ ] With active class filters, only visible outside nodes can be selected.
- [ ] No regressions in rack-to-rack link highlighting and cable map behavior.

### Diagnostics / build checks
- [ ] Run `npm run build` in `frontend/` and confirm success.
- [ ] Run `npm run dev` and verify browser console has no new React warnings/errors during:
  - rack select,
  - outside select,
  - outside drag,
  - panel close/reopen.
- [ ] Verify no unexpected network calls are introduced (outside click should not trigger new API requests).
- [ ] Confirm only intended frontend files changed:
  - `frontend/src/pages/MapPage.jsx`
  - `frontend/src/components/map/TopologyMap.jsx`
  - `frontend/src/components/map/RackDetail.jsx`

## Delivery Notes
- This plan intentionally avoids `useTopologyData` changes to keep scope minimal and avoid altering rack-session persistence behavior.
- Outside selection persistence across reload is explicitly out of scope for this minimal UX task.
