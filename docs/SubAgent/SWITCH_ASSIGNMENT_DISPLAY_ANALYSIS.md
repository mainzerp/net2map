# Switch Assignment Display Analysis

## Problem Statement

When editing a switch/device in the Devices tab, the edit form does not show existing rack, class, or model assignments that were made from other tabs (Racks, Classes, Models). In fact, the DevicesTab has **no edit form at all** -- it is purely an ignore/re-enable management view.

---

## 1. Frontend DevicesTab (`frontend/src/components/settings/DevicesTab.jsx`)

### Current Capabilities
- Fetches devices from `GET /api/devices` (line 13).
- Renders each device showing: `sys_name`, `ip`, port count, vendor/model text string, and ignored badge.
- Per-device action: Ignore / Re-enable toggle (calls `PATCH /api/topology/devices/{id}/meta` with `{ ignored: !dev.ignored }`).
- Bulk actions: Ignore Selected, Re-enable Selected (calls `PATCH /api/topology/devices/bulk-meta`).
- Checkbox multi-select for bulk operations.

### What Is Missing
- **No edit form/modal exists.** There is no `editState`, no `form` state, no `startEdit` function, no `submit` handler, and no modal JSX.
- **No display of `rack_id`, `class_id`, `model_id`** in device list rows. The data is returned by the API but completely unused.
- **No reference data fetched.** The component does not load racks, classes, or models -- so even if a form existed, there would be no data to populate dropdown selectors.
- **No Edit button** on individual device rows. Only Ignore/Re-enable buttons exist.

### Data Flow
```
DevicesTab
  |
  +-- refresh() --> GET /api/devices --> setDevices(data)
  |
  +-- toggleIgnored(dev) --> PATCH /api/topology/devices/{id}/meta { ignored: !dev.ignored }
  |
  +-- bulkIgnore(ignored) --> PATCH /api/topology/devices/bulk-meta { device_ids, ignored }
```

The response from `GET /api/devices` includes `rack_id`, `class_id`, `model_id` for each device (from `DeviceOut` schema), but these fields are never read or displayed.

---

## 2. Other Tabs: How Assignments Work

All three assignment tabs follow the same pattern. They fetch devices from `/api/topology` (nodes array), display them grouped by assignment, and use `PATCH /api/topology/devices/{devId}/meta` to set or clear the foreign key.

### RacksTab (`frontend/src/components/settings/RacksTab.jsx`)
- **Data sources:** `GET /api/racks` + `GET /api/topology` (for devices via `nodes`)
- **Assign:** `api.patch(/api/topology/devices/${devId}/meta, { rack_id: rackId })`
- **Unassign:** `api.patch(/api/topology/devices/${devId}/meta, { rack_id: null })`
- **UI:** Each rack card shows assigned devices. A dropdown of unassigned devices allows assigning new ones. An "x" button unassigns.
- **Filter for available:** `devices.filter(d => d.rack_id == null && (d.ports || []).length > 0)` -- only shows devices without a rack that have ports.

### SwitchClassesTab (`frontend/src/components/settings/SwitchClassesTab.jsx`)
- **Data sources:** `GET /api/switch-classes` + `GET /api/topology` (for devices)
- **Assign:** `api.patch(/api/topology/devices/${devId}/meta, { class_id: classId })`
- **Unassign:** `api.patch(/api/topology/devices/${devId}/meta, { class_id: null })`
- **UI:** Same card-per-class layout with assigned device chips and assignment dropdown.
- **Filter for available:** `devices.filter(d => d.class_id == null && (d.ports || []).length > 0)`

### SwitchModelsTab (`frontend/src/components/settings/SwitchModelsTab.jsx`)
- **Data sources:** `GET /api/switch-models` + `GET /api/topology` (for devices)
- **Assign:** `api.patch(/api/topology/devices/${devId}/meta, { model_id: modelId })`
- **Unassign:** `api.patch(/api/topology/devices/${devId}/meta, { model_id: null })`
- **UI:** Same card-per-model layout.
- **Filter for available:** `devices.filter(d => d.model_id == null && (d.ports || []).length > 0)`

### Key Observation
These tabs successfully assign rack/class/model to devices. The data persists in the database correctly. But when a user goes to the Devices tab, they cannot see or modify these assignments at all.

---

## 3. API Layer (`frontend/src/api.js`)

The API helper module provides:
- `api.get(path)` -- GET with ETag caching
- `api.patch(path, body)` -- PATCH for partial updates
- `api.invalidate(...paths)` -- Clear ETag cache entries

### Relevant Endpoints Used

| Endpoint | Used By | Purpose |
|---|---|---|
| `GET /api/devices` | DevicesTab | All devices (including ignored) |
| `GET /api/topology` | RacksTab, ClassesTab, ModelsTab, MapPage | Topology with nodes, links, racks, classes, models |
| `GET /api/racks` | RacksTab, CredentialsTab | Rack list for dropdowns |
| `GET /api/switch-classes` | ClassesTab, CredentialsTab | Class list for dropdowns |
| `GET /api/switch-models` | ModelsTab, CredentialsTab | Model list for dropdowns |
| `PATCH /api/topology/devices/{id}/meta` | All tabs | Update device metadata fields |

All necessary API methods exist. No new endpoints are needed.

---

## 4. Backend Schemas (`backend/schemas.py`)

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
**Already returns `rack_id`, `class_id`, `model_id`.**

### DeviceMetaUpdate (line 361)
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
**Already accepts `rack_id`, `class_id`, `model_id` for updates.**

### TopologyOut
```python
class TopologyOut(BaseModel):
    nodes:   List[DeviceOut]
    links:   List[TopologyLinkOut]
    racks:   List[RackOut]          = []
    classes: List[SwitchClassOut]   = []
    models:  List[SwitchModelOut]   = []
```
The topology endpoint bundles all reference data. The `/api/devices` endpoint only returns devices.

---

## 5. Backend Database Model (`backend/database.py`)

### Device model (line ~150)
```python
class Device(Base):
    __tablename__ = "devices"
    ...
    rack_id      = Column(Integer, ForeignKey("racks.id"), nullable=True)
    class_id     = Column(Integer, ForeignKey("switch_classes.id"), nullable=True)
    model_id     = Column(Integer, ForeignKey("switch_models.id"), nullable=True)

    rack         = relationship("Rack", back_populates="devices", lazy="joined")
    switch_class = relationship("SwitchClass", back_populates="devices", lazy="joined")
    switch_model = relationship("SwitchModel", back_populates="devices", lazy="joined")
```

All three foreign keys and relationships are defined. The database fully supports rack, class, and model assignments.

---

## 6. Backend Router: Device CRUD (`backend/routers/topology.py`)

### GET /api/devices (line 242)
```python
@router.get("/api/devices")
def list_all_devices(request, db):
    devices = db.query(Device).order_by(Device.ip).all()
    # ... resolves ports_per_row and total_ports from model
    # Returns list of DeviceOut
```
Returns all devices with `rack_id`, `class_id`, `model_id` populated.

### PATCH /api/topology/devices/{device_id}/meta (line 180)
```python
@router.patch("/api/topology/devices/{device_id}/meta", response_model=DeviceOut)
def update_device_meta(device_id, body: DeviceMetaUpdate, ...):
```
- Validates rack existence if `rack_id` is provided.
- Validates class existence if `class_id` is provided.
- Validates model existence if `model_id` is provided.
- Enforces outside-rack class rules (`allow_outside_rack`).
- Applies all fields from `DeviceMetaUpdate` using `exclude_unset=True` (only updates fields explicitly sent).

---

## 7. Reference Pattern: CredentialsTab

The CredentialsTab (`frontend/src/components/settings/CredentialsTab.jsx`) demonstrates the correct pattern for a form that includes rack/class/model dropdowns:

- Fetches reference data alongside its primary data:
  ```javascript
  Promise.allSettled([
    api.get("/api/credentials"),
    api.get("/api/devices"),
    api.get("/api/racks"),
    api.get("/api/switch-classes"),
    api.get("/api/switch-models"),
  ])
  ```
- `startEdit(c)` populates form with existing values: `rack_id: c.rack_id ?? null`, `class_id: c.class_id ?? null`
- Uses `<select>` dropdowns for rack and class, populated from the reference data arrays.
- Modal form pattern with `editState`, `form`, `err`, `submit`, `resetForm`.

---

## Root Cause Summary

The DevicesTab was originally built as a minimal view for toggling device ignore status. It was never expanded to include:

1. An edit form for device metadata.
2. Display of rack/class/model assignments in list rows.
3. Fetching reference data (racks, classes, models) for dropdown population.

The backend is fully ready -- `GET /api/devices` returns all assignment IDs, and `PATCH .../meta` accepts all assignment fields with validation. **This is a frontend-only gap.**

---

## What Needs to Change

### File to Modify
- `frontend/src/components/settings/DevicesTab.jsx` (the only file requiring changes)

### No Backend Changes Required
- `GET /api/devices` already returns `rack_id`, `class_id`, `model_id`
- `PATCH /api/topology/devices/{id}/meta` already accepts all fields via `DeviceMetaUpdate`
- Database model already has all foreign keys and relationships

### Required Frontend Additions

1. **State variables:** `racks`, `classes`, `models` (reference data); `editState` (modal control); `form` (edit form data); `err` (error display).

2. **Updated `refresh`/data-fetching:** Use `Promise.allSettled` to fetch `/api/devices`, `/api/racks`, `/api/switch-classes`, `/api/switch-models` simultaneously.

3. **`startEdit(dev)` function:** Populate form with current device values including `rack_id`, `class_id`, `model_id`.

4. **`submit` handler:** Call `PATCH /api/topology/devices/{editState.id}/meta` with form data. Invalidate caches. Refresh.

5. **Edit form modal (JSX):** Text inputs for `sys_name`, `location`, `vendor`, `model`. Select dropdowns for `rack_id`, `class_id`, `model_id` populated from reference data. Follow the same modal pattern as other tabs.

6. **Edit button per device row:** In the `renderDevice` function, add an Edit button that calls `startEdit(dev)`.

7. **Assignment display in list rows:** Show rack label, class label (with color dot), and model name as badges/chips next to each device for at-a-glance visibility.
