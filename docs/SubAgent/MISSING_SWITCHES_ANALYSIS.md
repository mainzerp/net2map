# Missing Switches in Settings Tabs - Analysis

## Problem Statement

In the Settings page, the Racks, Classes, and Models tabs show no switches available for assignment/selection in the dropdown menus.

---

## Data Flow Architecture

### How switches are loaded

All three tab components (RacksTab, SwitchClassesTab, SwitchModelsTab) follow the **same pattern**: they independently fetch devices from the `/api/topology` endpoint on mount, then derive "available" and "assigned" lists from the result.

```
SettingsPage
  |-- RacksTabContent         (only receives: newEntryTrigger prop)
  |-- ClassesTabContent       (only receives: newEntryTrigger prop)
  |-- ModelsTabContent        (only receives: newEntryTrigger prop)
```

**SettingsPage does NOT pass any switch/device data to the tabs.** Each tab loads its own data.

### Per-tab loading logic

Each tab's `refreshAll()` function:

```typescript
// RacksTab.tsx line 38-47
Promise.allSettled([api.get("/api/racks"), api.get("/api/topology")])
  .then(([racksRes, topoRes]) => {
    if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
    else setDevices([]);
  });

// SwitchClassesTab.tsx line 40-48
Promise.allSettled([api.get("/api/switch-classes"), api.get("/api/topology")])
  .then(([classesRes, topoRes]) => {
    if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
    else setDevices([]);
  });

// SwitchModelsTab.tsx line 41-49
Promise.allSettled([api.get("/api/switch-models"), api.get("/api/topology")])
  .then(([modelsRes, topoRes]) => {
    if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
    else setDevices([]);
  });
```

### "Available" device filtering

Each tab then filters `devices` for the assignment dropdown:

| Tab | "Available" filter | Code |
|---|---|---|
| RacksTab | `devices.filter(d => d.rack_id == null && (d.ports \|\| []).length > 0)` | line ~144 |
| ClassesTab | `devices.filter(d => d.class_id == null && (d.ports \|\| []).length > 0)` | line ~168 |
| ModelsTab | `devices.filter(d => d.model_id == null && (d.ports \|\| []).length > 0)` | line ~150 |

---

## Root Causes (Two Filters That Remove Devices)

### Filter 1 (Backend): Credential-gated topology query

**File:** `backend/routers/topology.py` lines 96-100

```python
# Only show devices that have a matching credential entry (assigned switches)
cred_ip_subq = db.query(Credential.ip).subquery()
nodes = db.query(Device).filter(
    Device.ignored == False,
    Device.ip.in_(db.query(cred_ip_subq.c.ip)),
).all()
```

The `/api/topology` endpoint only returns devices whose IP exists in the `credentials` table. If a device was discovered (e.g., via LLDP/CDP neighbor discovery or ping sweep) but has no credential entry, it is excluded from the topology response entirely.

**Introduced in:** commit `86274fa` ("feat: exclude unassigned devices from topology map")

This was intentional for the topology MAP view (to keep the map clean), but it creates a side effect: the Settings tabs also use `/api/topology` to populate their device lists, so devices without credentials are invisible in assignment dropdowns.

### Filter 2 (Frontend): Ports-based filtering

**Files:** RacksTab.tsx, SwitchClassesTab.tsx, SwitchModelsTab.tsx

```typescript
const available = devices.filter(d => d.rack_id == null && (d.ports || []).length > 0);
```

Even if a device passes the credential filter, it must ALSO have at least one port (`ports.length > 0`) to appear in the dropdown. Devices that have never been successfully scanned (or whose SNMP scan returned no ports) will always have an empty ports array and will be hidden.

**Introduced in:** commit `fe60cfb` ("feat: device ignore flag + assign-dropdown filter by scannable switches")

### Combined effect

A device must satisfy ALL of the following to appear in the assignment dropdown:
1. Exists in the `devices` table (discovered)
2. Has a matching entry in the `credentials` table (has SNMP/API credentials)
3. Is NOT ignored (`ignored == False`)
4. Has at least one port scanned (`ports.length > 0`)
5. Does not already have the relevant assignment (rack_id/class_id/model_id is null)

If any one of these fails, the device is invisible in the dropdown.

---

## The `/api/devices` Alternative

There is a separate endpoint `GET /api/devices` (topology.py line 244) that returns ALL devices regardless of credential status. It can optionally filter by `role=network` (with credentials) or `role=endpoint` (without credentials).

The Settings tabs currently do NOT use this endpoint; they use `/api/topology` which applies the credential filter.

---

## ETag Caching Consideration

The `api.get()` function uses ETag-based caching. All three tabs independently call `api.get("/api/topology")`, which shares the same cache key. This means:

- If one tab got a cached 304 response from a stale state, others would too
- After assigning/unassigning, tabs call `api.invalidate("/api/topology")` which correctly clears the cache
- This is unlikely to be the primary cause, but could lead to stale device lists in some edge cases

---

## Summary of Findings

| Aspect | Finding |
|---|---|
| **Where switches come from** | `/api/topology` endpoint, fetched independently by each tab component |
| **Why SettingsPage doesn't pass them** | Each tab is self-contained; SettingsPage only passes `newEntryTrigger` |
| **Backend filter (most likely cause)** | Topology only returns devices with credential entries (commit `86274fa`) |
| **Frontend filter (secondary cause)** | Dropdown only shows devices with `ports.length > 0` (commit `fe60cfb`) |
| **Alternative endpoint** | `/api/devices` exists and returns all devices, but tabs don't use it |

---

## Recommended Fix Approach

The settings tabs should fetch devices from `/api/devices` (or `/api/devices?role=network`) instead of relying on `/api/topology` for device lists. This separates the "what to show on the map" concern from the "what devices exist for assignment" concern.

Alternatively, the tabs could fetch both `/api/topology` (for current assignments) and `/api/devices` (for the available dropdown pool), or the `/api/topology` endpoint could be modified to accept a parameter that includes all devices.

The `ports.length > 0` filter should also be reconsidered -- it might make sense for racks (physical placement) but may be too restrictive for classes and models, which are metadata assignments.
