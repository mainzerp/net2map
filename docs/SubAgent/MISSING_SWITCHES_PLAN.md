# Missing Switches in Settings Tabs - Implementation Plan

## Problem Summary

The Racks, Classes, and Models settings tabs show no switches in the "Assign switch" dropdown because:

1. **Backend filter**: All three tabs fetch from `/api/topology`, which only returns devices that have a matching row in the `credentials` table (i.e., devices with SNMP/API credentials). Devices discovered via ping sweep or LLDP/CDP but lacking credentials are excluded.
2. **Frontend filter**: Each tab filters the devices list with `(d.ports || []).length > 0`, hiding any device that has never been successfully port-scanned.

Both filters are too restrictive for **assignment purposes** (rack/class/model assignment should show all known devices).

## Approach: Frontend-only fix using `/api/devices`

The `/api/devices` endpoint already exists and returns ALL devices from the database (no credential filter). It returns `DeviceOut[]` with the same shape as topology nodes (id, ip, sys_name, rack_id, class_id, model_id, ports, etc.).

The fix is minimal: each tab should fetch `/api/devices` instead of `/api/topology` for the device list used in the assignment dropdown. The `/api/topology` call is not needed at all in these tabs.

No backend changes required.

---

## Changes

### Step 1: RacksTab.tsx - Switch data source and remove ports filter

**File**: `frontend/src/components/settings/RacksTab.tsx`

- [ ] **1a.** In `refreshAll()` (~line 43), change `api.get("/api/topology")` to `api.get("/api/devices")`.
- [ ] **1b.** Update the result handler: the `/api/devices` response is a flat array (`DeviceOut[]`), not `{ nodes: [...] }`. Change `setDevices(topoRes.value?.nodes || [])` to `setDevices(topoRes.value || [])`.
- [ ] **1c.** In the card rendering (~line 144), remove the ports filter from the `available` computation. Change:
  ```ts
  const available = devices.filter(d => d.rack_id == null && (d.ports || []).length > 0);
  ```
  to:
  ```ts
  const available = devices.filter(d => d.rack_id == null);
  ```
- [ ] **1d.** Update `api.invalidate` calls in `assignDevice` and `unassignDevice`: add `"/api/devices"` to the invalidation list (keep `"/api/topology"` and `"/api/racks"` as they are since the topology map also needs refresh).

### Step 2: SwitchClassesTab.tsx - Switch data source and remove ports filter

**File**: `frontend/src/components/settings/SwitchClassesTab.tsx`

- [ ] **2a.** In `refreshAll()` (~line 47), change `api.get("/api/topology")` to `api.get("/api/devices")`.
- [ ] **2b.** Update the result handler: change `setDevices(topoRes.value?.nodes || [])` to `setDevices(topoRes.value || [])`.
- [ ] **2c.** In the card rendering (~line 168), remove the ports filter from the `available` computation. Change:
  ```ts
  const available = devices.filter(d => d.class_id == null && (d.ports || []).length > 0);
  ```
  to:
  ```ts
  const available = devices.filter(d => d.class_id == null);
  ```
- [ ] **2d.** Update `api.invalidate` calls in `assignDevice` and `unassignDevice`: add `"/api/devices"` alongside the existing `"/api/topology"`.

### Step 3: SwitchModelsTab.tsx - Switch data source and remove ports filter

**File**: `frontend/src/components/settings/SwitchModelsTab.tsx`

- [ ] **3a.** In `refreshAll()` (~line 49), change `api.get("/api/topology")` to `api.get("/api/devices")`.
- [ ] **3b.** Update the result handler: change `setDevices(topoRes.value?.nodes || [])` to `setDevices(topoRes.value || [])`.
- [ ] **3c.** In the card rendering (~line 150), remove the ports filter from the `available` computation. Change:
  ```ts
  const available = devices.filter(d => d.model_id == null && (d.ports || []).length > 0);
  ```
  to:
  ```ts
  const available = devices.filter(d => d.model_id == null);
  ```
- [ ] **3d.** Update `api.invalidate` calls in `assignDevice` and `unassignDevice`: add `"/api/devices"` alongside the existing `"/api/topology"`.

### Step 4: Clean up unused topology import (optional)

- [ ] **4a.** In each tab file, the `TopologyNode` type import remains valid -- the `/api/devices` endpoint returns `DeviceOut[]` which maps to the same `TopologyNode` interface on the frontend. No type changes needed.

---

## What Each Tab Actually Needs for the Dropdown

| Field | Used for |
|-------|----------|
| `id` | Value for the `<option>`, sent in PATCH to assign |
| `ip` | Display label in dropdown |
| `sys_name` | Display label in dropdown (preferred over IP) |
| `rack_id` / `class_id` / `model_id` | Filter: "not already assigned" |

The `/api/devices` endpoint returns all of these fields (via `DeviceOut` schema), so no additional endpoint or schema changes are needed.

---

## What Does NOT Change

- **Backend**: No changes. `/api/devices` already works correctly and returns all devices.
- **Topology map**: Still uses `/api/topology` with its credential filter -- map display is unaffected.
- **Assigned devices list**: The "ASSIGNED SWITCHES" section in each card uses `devices.filter(d => d.rack_id === rack.id)` etc. Since `/api/devices` includes all devices (including those with assignments), the assigned list will continue to show correctly.
- **PATCH endpoint**: The `PATCH /api/topology/devices/{id}/meta` endpoint works with any device ID regardless of credential status, so assigning rack/class/model to credential-less devices will work.
- **Type safety**: The `TopologyNode` TypeScript interface matches the `DeviceOut` response shape. No type changes needed.

---

## Verification

After implementation, verify:
1. Open Settings > Racks tab, create a rack -- the "Assign switch" dropdown should list ALL non-ignored devices (not just those with credentials and ports).
2. Same for Classes and Models tabs.
3. Assign a device without credentials to a rack -- it should appear in the "ASSIGNED SWITCHES" list.
4. Unassign it -- it should reappear in the dropdown.
5. The topology map should remain unaffected (still shows only credentialed devices).

---

## Files Modified

| File | Changes |
|------|---------|
| `frontend/src/components/settings/RacksTab.tsx` | Fetch from `/api/devices`, remove ports filter, update cache invalidation |
| `frontend/src/components/settings/SwitchClassesTab.tsx` | Fetch from `/api/devices`, remove ports filter, update cache invalidation |
| `frontend/src/components/settings/SwitchModelsTab.tsx` | Fetch from `/api/devices`, remove ports filter, update cache invalidation |
