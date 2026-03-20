# Edit Switch Form Analysis

## Summary

There are **two** edit forms for switches in the application, with a **data synchronization bug** between Credential and Device records that causes stale rack/class values in the CredentialsTab form.

---

## Edit Forms Identified

### 1. DeviceTable.tsx (Network Page / Devices Page)

- **File**: `frontend/src/components/DeviceTable.tsx`
- **Form title**: "EDIT DEVICE"
- **Triggered by**: "Edit" button on each row in Network or Devices page
- **Fields**: `rack_id`, `class_id` (network role only), `model_id` (network role only)
- **Data source**: `DeviceRecord` from `/api/devices?role=network` (or `?role=endpoint`)

### 2. CredentialsTab.tsx (Settings Page)

- **File**: `frontend/src/components/settings/CredentialsTab.tsx`
- **Form title**: "EDIT ENTRY"
- **Triggered by**: "Edit" button next to each credential in Settings > Credentials tab
- **Fields**: `rack_id`, `class_id`, `model` (string name, NOT model_id), plus SNMP config
- **Data source**: `Credential` object from `/api/credentials`

---

## Data Model (backend/database.py)

Both `Credential` and `Device` have **independent** `rack_id` and `class_id` columns:

| Field | Credential table | Device table |
|-------|-----------------|--------------|
| rack_id | Yes (FK -> racks.id) | Yes (FK -> racks.id) |
| class_id | Yes (FK -> switch_classes.id) | Yes (FK -> switch_classes.id) |
| model_id | NO | Yes (FK -> switch_models.id) |
| model | Yes (string name) | Yes (string name) |

---

## Bug: One-Way Sync Between Credential and Device

### Credential -> Device sync: WORKS

When a credential is created/updated via CredentialsTab (`PUT /api/credentials/{id}`), the backend (`backend/routers/credentials.py` lines 86-106) syncs `rack_id` and `class_id` to the corresponding Device record:

```python
# credentials.py update_credential()
if device:
    if "rack_id" in updates:
        device.rack_id = cred.rack_id
    if "class_id" in updates:
        device.class_id = cred.class_id
```

### Device -> Credential sync: DOES NOT WORK (BUG)

When rack/class is changed via:
- **RacksTab** (`PATCH /api/topology/devices/{id}/meta` with `rack_id`)
- **SwitchClassesTab** (`PATCH /api/topology/devices/{id}/meta` with `class_id`)
- **SwitchModelsTab** (`PATCH /api/topology/devices/{id}/meta` with `model_id`)
- **DeviceTable Edit form** (`PATCH /api/topology/devices/{id}/meta`)

...the backend (`backend/routers/topology.py` `update_device_meta()` lines 182-240) updates ONLY the `Device` record. The corresponding `Credential` record is **never updated**.

### User-Visible Impact

1. User goes to Settings > Racks, assigns "Switch-01" to "Rack A"
   - Backend patches Device.rack_id = (rack A id)
   - Credential.rack_id remains NULL
2. User goes to Settings > Credentials, clicks "Edit" on the Switch-01 credential
   - `startEdit(c)` reads `c.rack_id` from the Credential record
   - Form shows "-- No rack --" even though the device IS in Rack A
3. If user saves the credential form without changing rack, the credential's NULL rack_id gets synced BACK to the device, **removing the rack assignment entirely**

---

## DeviceTable Edit Form (Network Page) -- Works Correctly

The DeviceTable edit form on the Network page does NOT have this problem because:

1. It reads `rack_id`, `class_id`, `model_id` from the **Device** record (via `/api/devices?role=network`)
2. `startEdit(dev)` correctly reads `dev.rack_id`, `dev.class_id`, `dev.model_id`
3. `submitEdit()` patches `/api/topology/devices/{id}/meta` which updates the Device directly
4. ETag cache is properly invalidated by Settings tabs (`api.invalidate(...)`)
5. On page navigation (remount), `refresh()` fetches fresh data

**The DeviceTable form is correct.**

---

## Dropdown Options -- Work Correctly

Both forms load dropdown options from the correct endpoints:

| Dropdown | Endpoint | Both forms? |
|----------|----------|-------------|
| Racks | `GET /api/racks` | Yes |
| Classes | `GET /api/switch-classes` | Yes |
| Models | `GET /api/switch-models` | DeviceTable: model_id dropdown; CredentialsTab: model name dropdown |

Options are fetched via `Promise.allSettled()` in each component's `refresh()` and populated correctly.

---

## ETag Caching -- Minor Issue

The Settings tabs invalidate these cache keys after assignments:
- RacksTab: `"/api/topology", "/api/racks", "/api/devices?role=network"`
- SwitchClassesTab: `"/api/topology", "/api/devices?role=network"`
- SwitchModelsTab: `"/api/topology", "/api/devices?role=network"`

Missing invalidation: **`/api/credentials`** is never invalidated by these tabs (because they don't update credentials -- part of the core bug).

Also missing: **`/api/devices?role=endpoint`** is not invalidated by SwitchClassesTab or SwitchModelsTab (though endpoint devices rarely have class/model assignments, this is a minor issue).

---

## Root Cause Summary

| Issue | Severity | Location |
|-------|----------|----------|
| Device meta updates don't sync to Credential records | HIGH | `backend/routers/topology.py` `update_device_meta()` |
| CredentialsTab edit form reads stale Credential rack_id/class_id | HIGH | `frontend/src/components/settings/CredentialsTab.tsx` `startEdit()` |
| Saving credential form can overwrite device assignments with stale values | CRITICAL | `backend/routers/credentials.py` `update_credential()` |
| CredentialsTab has no model_id field (uses string model name instead) | LOW | Design inconsistency, not a bug per se |

---

## Recommended Fix

### Option A: Backend sync (Device -> Credential)

In `backend/routers/topology.py` `update_device_meta()`, after updating the Device, also update the corresponding Credential record:

```python
# After device update, sync to credential
if "rack_id" in payload or "class_id" in payload:
    cred = db.query(Credential).filter(Credential.ip == device.ip).first()
    if cred:
        if "rack_id" in payload:
            cred.rack_id = device.rack_id
        if "class_id" in payload:
            cred.class_id = device.class_id
```

### Option B: Frontend fix (CredentialsTab reads from Device)

When editing a credential, cross-reference the device list to get the actual rack_id/class_id:

```javascript
const startEdit = (c: Credential) => {
    const dev = devices.find(d => d.ip === c.ip);
    setForm({
        ...
        rack_id: dev?.rack_id ?? c.rack_id ?? null,
        class_id: dev?.class_id ?? c.class_id ?? null,
        ...
    });
};
```

### Recommendation

**Use Option A (backend sync)** as the primary fix. This ensures both records stay consistent regardless of which UI or API is used. Option B can be added as a belt-and-suspenders safeguard.

Also add ETag cache invalidation for `/api/credentials` in the Settings tabs that modify device meta.

---

## Files Examined

- `frontend/src/components/DeviceTable.tsx` -- Network/Devices page edit form
- `frontend/src/components/settings/CredentialsTab.tsx` -- Settings credentials edit form
- `frontend/src/components/settings/RacksTab.tsx` -- Rack assignment flow
- `frontend/src/components/settings/SwitchClassesTab.tsx` -- Class assignment flow
- `frontend/src/components/settings/SwitchModelsTab.tsx` -- Model assignment flow
- `frontend/src/components/SwitchDetailSlideIn.tsx` -- Port detail slide-in (no edit form, read-only)
- `frontend/src/pages/DevicesPage.tsx` -- DeviceTable wrapper (endpoint role)
- `frontend/src/pages/NetworkPage.tsx` -- DeviceTable wrapper (network role)
- `frontend/src/api.ts` -- ETag cache mechanism
- `frontend/src/types.ts` -- TypeScript interfaces
- `backend/database.py` -- Credential and Device models
- `backend/routers/credentials.py` -- Credential CRUD with device sync
- `backend/routers/topology.py` -- Device meta update (no credential sync)
