# Device Edit Assignments Analysis

## Problem Statement

When a switch gets assigned a rack, class, or model through the Racks, Classes, or Models tabs, the Devices/Switches tab does not reflect those assignments. The editing capabilities and assignment visibility are missing from the DevicesTab component.

---

## 1. DevicesTab Component (frontend/src/components/settings/DevicesTab.jsx)

### Current State
- **No edit form exists.** The component is a simple list with ignore/re-enable toggle only.
- Fetches devices from `GET /api/devices` (line 13).
- Renders each device showing: `sys_name`, `ip`, port count, vendor/model text, and ignored status.
- Only two actions available per device: Ignore and Re-enable (via `toggleIgnored`).
- Bulk actions: Ignore Selected, Re-enable Selected.
- **No modal, no form, no `startEdit` function, no `editState` state variable.**
- Does **not** display `rack_id`, `class_id`, or `model_id` anywhere.
- Does **not** fetch racks, classes, or models reference data.

### What's Missing
1. Edit form/modal for device metadata (like all other tabs have).
2. Display of current rack/class/model assignments in the device list rows.
3. Dropdown selectors for rack, class, and model in an edit form.
4. Loading reference data (racks, classes, models) for populating dropdowns.
5. A `startEdit` function that populates the form with the device's current `rack_id`, `class_id`, `model_id` (and other editable fields like `sys_name`, `location`, `vendor`, `model`).

---

## 2. RacksTab, SwitchClassesTab, SwitchModelsTab

All three tabs follow the same assignment pattern:

### RacksTab (RacksTab.jsx)
- Fetches devices from `/api/topology` (nodes).
- Assigns devices to racks via: `api.patch(/api/topology/devices/${devId}/meta, { rack_id: rackId })`.
- Unassigns via: `api.patch(/api/topology/devices/${devId}/meta, { rack_id: null })`.
- Uses a per-rack dropdown (`assignSel`) to pick a device, then assigns.
- Shows assigned devices within each rack's card.

### SwitchClassesTab (SwitchClassesTab.jsx)
- Fetches devices from `/api/topology` (nodes).
- Assigns devices to classes via: `api.patch(/api/topology/devices/${devId}/meta, { class_id: classId })`.
- Unassigns via: `api.patch(/api/topology/devices/${devId}/meta, { class_id: null })`.
- Same dropdown pattern per class.

### SwitchModelsTab (SwitchModelsTab.jsx)
- Fetches devices from `/api/topology` (nodes).
- Assigns devices to models via: `api.patch(/api/topology/devices/${devId}/meta, { model_id: modelId })`.
- Unassigns via: `api.patch(/api/topology/devices/${devId}/meta, { model_id: null })`.
- Same dropdown pattern per model.

**Key observation:** These tabs successfully set `rack_id`, `class_id`, and `model_id` on devices. The backend stores these correctly. But DevicesTab never reads or shows them.

---

## 3. Backend API Endpoints

### GET /api/devices (routers/topology.py, line 242)
- Returns **all** devices (including ignored) for the settings UI.
- Uses `DeviceOut` schema which **includes** `rack_id`, `class_id`, `model_id`.
- Also resolves `ports_per_row` and `total_ports` from the switch model.
- The data is available; the frontend simply doesn't use it.

### PATCH /api/topology/devices/{device_id}/meta (routers/topology.py, line 185)
- Accepts `DeviceMetaUpdate` schema with fields: `location`, `sys_name`, `vendor`, `model`, `rack_id`, `class_id`, `model_id`, `ignored`.
- Validates rack/class/model existence.
- Enforces outside-rack class rules.
- Returns updated `DeviceOut`.

### GET /api/topology (routers/topology.py, line 82)
- Returns topology with nodes (devices), links, racks, classes, models.
- Only un-ignored devices with matching credentials.
- Used by RacksTab, ClassesTab, ModelsTab for their device lists.

---

## 4. Backend Schemas (backend/schemas.py)

### DeviceOut (line 339)
```python
class DeviceOut(DeviceBase):
    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    ports_per_row: Optional[int] = None
    total_ports:   Optional[int] = None
```

### DeviceMetaUpdate (line 363)
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

**All necessary fields are already in the schema.** No backend changes needed.

---

## 5. Database Model (backend/database.py)

### Device model (line 150)
- `rack_id = Column(Integer, ForeignKey("racks.id"), nullable=True)`
- `class_id = Column(Integer, ForeignKey("switch_classes.id"), nullable=True)`
- `model_id = Column(Integer, ForeignKey("switch_models.id"), nullable=True)`
- Relationships: `rack`, `switch_class`, `switch_model` (all with `lazy="joined"`).

**Database fully supports all assignments.** No schema changes needed.

---

## 6. CredentialsTab Pattern (reference for fix)

The CredentialsTab (CredentialsTab.jsx) demonstrates the correct pattern:

### Data Fetching
Fetches all reference data for dropdowns:
```javascript
Promise.allSettled([
  api.get("/api/credentials"),
  api.get("/api/devices"),
  api.get("/api/racks"),
  api.get("/api/switch-classes"),
  api.get("/api/switch-models"),
])
```

### startEdit Function
Correctly populates form with all current values when editing:
```javascript
const startEdit = (c) => {
  setForm({
    label: c.label, ip: c.ip, priority: c.priority ?? 0,
    ...,
    rack_id: c.rack_id ?? null,
    class_id: c.class_id ?? null,
    vendor: c.vendor ?? "generic", model: c.model ?? "",
    ...
  });
  setEditState({ id: c.id, open: true });
};
```

### Form Structure
Uses `<select>` dropdowns populated from `racks`, `classes`, `models` state arrays.

---

## 7. Frontend API Layer (frontend/src/api.js)

- `api.get("/api/devices")` - fetches all devices (used by DevicesTab).
- `api.patch(path, body)` - PATCH requests for meta updates.
- `api.invalidate(...paths)` - clears ETag cache to force fresh fetch.
- All necessary API methods already exist.

---

## Root Cause

The DevicesTab was built as a minimal "ignore management" view. It never had an edit form. When the Racks, Classes, and Models tabs were added with device assignment features, the DevicesTab was not updated to:
1. Display current assignments.
2. Provide an edit form for changing assignments.
3. Fetch reference data (racks, classes, models) for dropdowns.

The backend already returns `rack_id`, `class_id`, and `model_id` in the `/api/devices` response. The `PATCH /api/topology/devices/{id}/meta` endpoint already accepts all these fields. The fix is purely frontend.

---

## Required Changes (Frontend Only)

### DevicesTab.jsx needs:

1. **New state variables:**
   - `racks`, `classes`, `models` - reference data for dropdowns
   - `editState` - `{ id: null, open: false }` for modal control
   - `form` - form data with fields: `sys_name`, `location`, `vendor`, `model`, `rack_id`, `class_id`, `model_id`
   - `err` - form error state

2. **Updated `refresh` to fetch reference data:**
   - Add `api.get("/api/racks")`, `api.get("/api/switch-classes")`, `api.get("/api/switch-models")` alongside existing `api.get("/api/devices")`

3. **New `startEdit(dev)` function:**
   - Must populate form with device's current values including `rack_id`, `class_id`, `model_id`
   - Pattern: `setForm({ sys_name: dev.sys_name, ..., rack_id: dev.rack_id ?? null, class_id: dev.class_id ?? null, model_id: dev.model_id ?? null })`

4. **New `submit` function:**
   - Calls `api.patch(/api/topology/devices/${editState.id}/meta, form)`
   - Invalidates caches, refreshes list

5. **Edit form modal (JSX):**
   - Text inputs for: `sys_name`, `location`, `vendor`, `model`
   - Select dropdowns for: `rack_id` (from racks), `class_id` (from classes), `model_id` (from models)
   - Follow the same modal pattern as RacksTab, ClassesTab, CredentialsTab

6. **Edit button in device rows:**
   - Add a pencil/edit button next to each device that calls `startEdit(dev)`

7. **Display current assignments in list rows:**
   - Show rack label, class label, model name next to each device for visibility

### Files to Modify
- `frontend/src/components/settings/DevicesTab.jsx` - the only file that needs changes

### No Backend Changes Required
- `GET /api/devices` already returns `rack_id`, `class_id`, `model_id`
- `PATCH /api/topology/devices/{id}/meta` already accepts all fields via `DeviceMetaUpdate`
- Database model already has all relationships
