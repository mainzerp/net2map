# Topology Ports & Links - Implementation Plan

**Date:** 2026-02-24
**Based on:** docs/SubAgent/TOPOLOGY_PORTS_ANALYSIS.md
**Priority order:** 2.1 -> 2.4 -> 2.2 -> 2.5 -> 2.6 -> 2.7

---

## Overview

Six files are modified. Changes are ordered so that upstream fixes (ETag cache) eliminate
entire categories of downstream bugs before more surgical fixes are applied.

| Step | Issue | File | Severity |
|------|-------|------|----------|
| 1 | 2.1 ETag cache returns stale/shared object | `frontend/src/api.js` | High |
| 2 | 2.1 `initializedRef` race in reload path | `frontend/src/hooks/useTopologyData.js` | High |
| 3 | 2.4 Port key normalisation | `frontend/src/api.js` | High |
| 4 | 2.4 Port key normalisation (SwitchPanel) | `frontend/src/components/SwitchPanel.jsx` | High |
| 5 | 2.4 Port key normalisation (Port highlight) | `frontend/src/components/Port.jsx` | High |
| 6 | 2.4 Port key normalisation (RackDetail linkColorMap) | `frontend/src/components/map/RackDetail.jsx` | High |
| 7 | 2.2 Derive selectedRack.devices from topology.nodes | `frontend/src/pages/MapPage.jsx` | Medium |
| 8 | 2.2 Remove stale devices sync from loadTopology | `frontend/src/hooks/useTopologyData.js` | Medium |
| 9 | 2.5 Build ipToRackId from unfiltered nodes | `frontend/src/components/map/TopologyMap.jsx` | Medium |
| 10 | 2.6 Null guard in onMouseUp | `frontend/src/components/map/TopologyMap.jsx` | Low |
| 11 | 2.7 Null guard on d.ports in TopologyMap | `frontend/src/components/map/TopologyMap.jsx` | Low |
| 12 | 2.7 Null guard on device.ports in RackDetail | `frontend/src/components/map/RackDetail.jsx` | Low |

---

## Step 1 — Fix ETag Cache Returning Stale/Shared Object

**File:** `frontend/src/api.js`
**Issue:** 2.1 — When HTTP 304 is returned the cached JS object is returned by reference.
Any downstream mutation of that object poisons the cache for future callers. Additionally
the cache stores data by reference after a 200 response, so the stored reference and the
returned reference are the same object.

**Root cause line (current):**
```
// Line 29 — returns shared cache reference on 304
if (r.status === 304) {
  if (_etagCache[path]) return _etagCache[path].data;
  ...
}
// Line 37 — stores and returns same object reference on 200
const data = await r.json();
if (etag) {
  _etagCache[path] = { etag, data };
  ...
}
return data;
```

**Fix:** Return `structuredClone(...)` on both the 304 and 200 paths so callers always
receive an independent copy that cannot poison the cache.

**Exact change in `api.js`:**

OLD (lines 28-45 approximately):
```javascript
    if (r.status === 304) {
      if (_etagCache[path]) return _etagCache[path].data;
      // Cache miss despite 304 - re-fetch without ETag
      const r2 = await fetch(`${API}${path}`, { headers: { ..._authHeader } });
      await _checkOk(r2);
      const data2 = await r2.json();
      return data2;
    }
    await _checkOk(r);
    const etag = r.headers.get("ETag");
    const data = await r.json();
    if (etag) {
      _etagCache[path] = { etag, data };
      const keys = Object.keys(_etagCache);
      if (keys.length > 200) {
        delete _etagCache[keys[0]]; // evict oldest entry
      }
    }
    return data;
```

NEW:
```javascript
    if (r.status === 304) {
      if (_etagCache[path]) return structuredClone(_etagCache[path].data);
      // Cache miss despite 304 - re-fetch without ETag
      const r2 = await fetch(`${API}${path}`, { headers: { ..._authHeader } });
      await _checkOk(r2);
      const data2 = await r2.json();
      return data2;
    }
    await _checkOk(r);
    const etag = r.headers.get("ETag");
    const data = await r.json();
    if (etag) {
      _etagCache[path] = { etag, data: structuredClone(data) };
      const keys = Object.keys(_etagCache);
      if (keys.length > 200) {
        delete _etagCache[keys[0]]; // evict oldest entry
      }
    }
    return data;
```

**Why this fixes it:**
- On 304: caller receives a deep clone, not the live cached object. Mutations by React
  state cannot corrupt the cache.
- On 200: the cache stores a clone; the returned `data` and the cached copy are
  independent. A new object is always returned, so `topology.nodes` will be a new array
  reference after every `loadTopology()` call, which guarantees that the `useEffect`
  in `TopologyMap` that rebuilds `positions` will re-run (fixing Issue 2.3 as a side
  effect).

---

## Step 2 — Fix `initializedRef` Race in Reload Path

**File:** `frontend/src/hooks/useTopologyData.js`
**Issue:** 2.1 (secondary) — `initializedRef.current` is only set inside the
`useEffect` initial-load callback. If `loadTopology()` resolves first (race on mount),
`initializedRef` stays `false`, the `selectedRack` persistence `useEffect` is silently
suppressed, and a re-render after reload can wipe the active rack selection.

**Current code (lines ~11-46):**
```javascript
const loadTopology = useCallback(() => {
  api.get("/api/topology").then(data => {
    setTopology(data);
    // Keep selectedRack.devices in sync after reload
    setSelectedRack(prev => {
      if (!prev) return prev;
      const freshDevices = data.nodes.filter(n => n.rack_id === prev.id);
      return freshDevices.length > 0 ? { ...prev, devices: freshDevices } : prev;
    });
  }).catch(e => setLoadError(e.message || "Failed to load topology"));
}, []);  // NOTE: no selectedRack dependency — uses functional setState

// Initial load + sessionStorage selectedRack restore
useEffect(() => {
  api.get("/api/topology").then(data => {
    setTopology(data);
    const savedId = sessionStorage.getItem("selectedRackId");
    if (savedId) {
      ...
    }
    initializedRef.current = true;   // <-- only set here
  }).catch(e => setLoadError(e.message || "Failed to load topology"));
}, []);
```

**Fix:** Set `initializedRef.current = true` at the top of the `loadTopology` callback
as well (before any async work completes is fine — it only guards session-storage
persistence, not data correctness). Also remove the stale `devices` sync from
`loadTopology` — that responsibility moves to `MapPage` in Step 7.

**Exact change — replace the `loadTopology` useCallback:**

OLD:
```javascript
  const loadTopology = useCallback(() => {
    api.get("/api/topology").then(data => {
      setTopology(data);
      // Keep selectedRack.devices in sync after reload
      setSelectedRack(prev => {
        if (!prev) return prev;
        const freshDevices = data.nodes.filter(n => n.rack_id === prev.id);
        return freshDevices.length > 0 ? { ...prev, devices: freshDevices } : prev;
      });
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);  // NOTE: no selectedRack dependency — uses functional setState
```

NEW:
```javascript
  const loadTopology = useCallback(() => {
    initializedRef.current = true;
    api.get("/api/topology").then(data => {
      setTopology(data);
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);
```

**Why this fixes it:**
- `initializedRef.current = true` is set synchronously before the fetch so the
  sessionStorage persistence effect is unblocked from the first call to `loadTopology`.
- Removing the manual `setSelectedRack(prev => ...)` devices re-sync eliminates the
  one-cycle lag described in Issue 2.2. The derived `selectedRack.devices` (Step 7 in
  `MapPage`) replaces this responsibility.

---

## Step 3 — Port Key Normalisation in `buildPortLinkMap`

**File:** `frontend/src/api.js`
**Issue:** 2.4 — `buildPortLinkMap` stores keys as `"${l.local_ip}:${l.local_port}"`.
`local_port` and `remote_port` come from LLDP and may differ in case or whitespace from
`port.if_descr` (e.g. `"GigabitEthernet1"` vs `"gigabitethernet1"` or `"Gi1"` vs
`"gi1"`). The `SwitchPanel` lookup key uses `if_descr` verbatim, so exact matches fail
silently on many vendors.

**Current code (end of `api.js`):**
```javascript
export function buildPortLinkMap(links) {
  const m = {};
  links.forEach(l => {
    m[`${l.local_ip}:${l.local_port}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${l.remote_port}`] = { link: l, role: "to"   };
  });
  return m;
}
```

**Fix:** Normalise port identifiers to lowercase + trimmed before using them as map keys.
Add a small private helper `_normPort` that is also exported so `SwitchPanel` can import
and use the exact same normalisation logic.

**Exact change:**

OLD:
```javascript
export function buildPortLinkMap(links) {
  const m = {};
  links.forEach(l => {
    m[`${l.local_ip}:${l.local_port}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${l.remote_port}`] = { link: l, role: "to"   };
  });
  return m;
}
```

NEW:
```javascript
// Normalise a port identifier so LLDP port IDs and SNMP ifDescr values
// can be compared case-insensitively after trimming whitespace.
export function normPort(s) {
  return (s || "").trim().toLowerCase();
}

export function buildPortLinkMap(links) {
  const m = {};
  links.forEach(l => {
    m[`${l.local_ip}:${normPort(l.local_port)}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${normPort(l.remote_port)}`] = { link: l, role: "to"   };
  });
  return m;
}
```

---

## Step 4 — Port Key Normalisation in SwitchPanel

**File:** `frontend/src/components/SwitchPanel.jsx`
**Issue:** 2.4 — The lookup key uses `port.if_descr` verbatim; must apply the same
`normPort` normalisation so the key matches the one stored in `portLinkMap`.

**Current import line:**
```javascript
import { speedColor } from "../api.js";
```

**Fix — update import to also bring in `normPort`:**

OLD:
```javascript
import { speedColor } from "../api.js";
```

NEW:
```javascript
import { speedColor, normPort } from "../api.js";
```

**Current key construction inside the port map render (two occurrences, both in the same
IIFE — top row and bottom row):**
```javascript
const pKey = `${device.ip}:${port.if_descr}`;
```

Both occurrences must be updated. There are exactly two — one for `topRow.map` and one
for `botRow.map`.

**Fix — replace both occurrences:**

OLD (topRow):
```javascript
                    {topRow.map(port => {
                      const pKey = `${device.ip}:${port.if_descr}`;
                      return (
```

NEW (topRow):
```javascript
                    {topRow.map(port => {
                      const pKey = `${device.ip}:${normPort(port.if_descr)}`;
                      return (
```

OLD (botRow):
```javascript
                    {botRow.map(port => {
                      const pKey = `${device.ip}:${port.if_descr}`;
                      return (
```

NEW (botRow):
```javascript
                    {botRow.map(port => {
                      const pKey = `${device.ip}:${normPort(port.if_descr)}`;
                      return (
```

---

## Step 5 — Port Key Normalisation in Port.jsx Highlight Logic

**File:** `frontend/src/components/Port.jsx`
**Issue:** 2.4 — The `selectedLink` highlight comparison builds `sKey` and `dKey` from
`selectedLink.local_port` / `selectedLink.remote_port` verbatim. These must also be
normalised so the highlight matches the normalised `portKey` passed in from `SwitchPanel`.

**Current highlight code (lines ~28-35):**
```javascript
  let hl = null;
  if (selectedLink && portKey) {
    const sKey = `${selectedLink.local_ip}:${selectedLink.local_port}`;
    const dKey = `${selectedLink.remote_ip}:${selectedLink.remote_port}`;
    if (portKey === sKey) hl = "from";
    else if (portKey === dKey) hl = "to";
    else if (isLinked) hl = "dim";
  }
```

**Fix — import `normPort` and normalise the highlight keys:**

Update the import at the top of `Port.jsx`:

OLD:
```javascript
import { speedLabel, speedColor } from "../api.js";
```

NEW:
```javascript
import { speedLabel, speedColor, normPort } from "../api.js";
```

Update the highlight key construction:

OLD:
```javascript
  let hl = null;
  if (selectedLink && portKey) {
    const sKey = `${selectedLink.local_ip}:${selectedLink.local_port}`;
    const dKey = `${selectedLink.remote_ip}:${selectedLink.remote_port}`;
    if (portKey === sKey) hl = "from";
    else if (portKey === dKey) hl = "to";
    else if (isLinked) hl = "dim";
  }
```

NEW:
```javascript
  let hl = null;
  if (selectedLink && portKey) {
    const sKey = `${selectedLink.local_ip}:${normPort(selectedLink.local_port)}`;
    const dKey = `${selectedLink.remote_ip}:${normPort(selectedLink.remote_port)}`;
    if (portKey === sKey) hl = "from";
    else if (portKey === dKey) hl = "to";
    else if (isLinked) hl = "dim";
  }
```

Also update the `handleClick` identity comparison so the "deselect on re-click" logic
remains consistent:

OLD (inside handleClick):
```javascript
    const isSame = selectedLink?.local_ip===link.local_ip && selectedLink?.local_port===link.local_port;
```

NEW:
```javascript
    const isSame = selectedLink?.local_ip===link.local_ip && normPort(selectedLink?.local_port)===normPort(link.local_port);
```

---

## Step 6 — Port Key Normalisation in RackDetail linkColorMap

**File:** `frontend/src/components/map/RackDetail.jsx`
**Issue:** 2.4 — `linkColorMap` stores cable color assignments keyed by
`"${l.local_ip}:${l.local_port}"`. `SwitchPanel` now looks up colors using normalised
keys (from Step 4). The `linkColorMap` keys must also be normalised to match.

**Current code (lines ~87-94):**
```javascript
  const linkColorMap  = useMemo(() => {
    const m = {};
    allIntraLinks.forEach((l, i) => {
      const c = CABLE_COLORS[i % CABLE_COLORS.length];
      m[`${l.local_ip}:${l.local_port}`]   = c;
      m[`${l.remote_ip}:${l.remote_port}`] = c;
    });
    return m;
  }, [allIntraLinks]);
```

**Fix — import `normPort` and use it in `linkColorMap`:**

Update the import in `RackDetail.jsx`:

OLD:
```javascript
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap } from "../../api.js";
```

NEW:
```javascript
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap, normPort } from "../../api.js";
```

Update `linkColorMap` memo:

OLD:
```javascript
  const linkColorMap  = useMemo(() => {
    const m = {};
    allIntraLinks.forEach((l, i) => {
      const c = CABLE_COLORS[i % CABLE_COLORS.length];
      m[`${l.local_ip}:${l.local_port}`]   = c;
      m[`${l.remote_ip}:${l.remote_port}`] = c;
    });
    return m;
  }, [allIntraLinks]);
```

NEW:
```javascript
  const linkColorMap  = useMemo(() => {
    const m = {};
    allIntraLinks.forEach((l, i) => {
      const c = CABLE_COLORS[i % CABLE_COLORS.length];
      m[`${l.local_ip}:${normPort(l.local_port)}`]   = c;
      m[`${l.remote_ip}:${normPort(l.remote_port)}`] = c;
    });
    return m;
  }, [allIntraLinks]);
```

---

## Step 7 — Derive `selectedRack.devices` from `topology.nodes` in MapPage

**File:** `frontend/src/pages/MapPage.jsx`
**Issue:** 2.2 — `selectedRack` is stored as state with a `.devices` array that is
manually kept in sync. After `loadTopology()` resolves there is a render where
`selectedRack.devices` still contains the old node objects while `topology.nodes` has
already been updated. `RackDetail` receives the stale rack object for that render cycle,
displaying outdated port counts and link data.

**Fix:** Keep `selectedRack` as a lightweight `{ id, label, location }` identity object
(no `.devices`). Compute `.devices` on-the-fly from `topology.nodes` via a `useMemo`.
Pass the enriched rack object to `RackDetail`.

**Step 7a — Add `selectedRackFull` derived memo after the `allRacks` memo:**

Find the existing `allRacks` memo and insert after it:

OLD (the line after the `allRacks` memo closing brace):
```javascript
  }, [topology.nodes, topology.racks]);

  const savePosition = (id, x, y) => {
```

NEW:
```javascript
  }, [topology.nodes, topology.racks]);

  // Derive the full selectedRack object (with up-to-date devices) directly from
  // topology.nodes so RackDetail always sees fresh data after every loadTopology call.
  const selectedRackFull = useMemo(() => {
    if (!selectedRack) return null;
    const devices = topology.nodes.filter(n => n.rack_id === selectedRack.id);
    return { ...selectedRack, devices };
  }, [selectedRack, topology.nodes]);

  const savePosition = (id, x, y) => {
```

**Step 7b — Replace all uses of `selectedRack` where the `.devices` array matters:**

The `RackDetail` component and the `panelOpen` conditional both reference `selectedRack`.
Update the JSX to use `selectedRackFull` for `RackDetail` and its surrounding condition:

OLD:
```javascript
      {selectedRack && (
        <RackDetail
          rack={selectedRack}
```

NEW:
```javascript
      {selectedRackFull && (
        <RackDetail
          rack={selectedRackFull}
```

Also update the `deviceOrder` and `onClose` props block that closes the `RackDetail`
call — they reference `selectedRack.id` which is fine (identity, not devices):

No change needed there; `selectedRack?.id` is still valid because `selectedRack` is still
the lightweight state object.

**Step 7c — Update `moveDevice` to not manually patch `selectedRack.devices`:**

Because `selectedRackFull.devices` is now derived, the manual filter in `moveDevice` is
no longer needed and can be simplified:

OLD:
```javascript
  const moveDevice = async (device, newRackId) => {
    const rId = newRackId === "__unassigned__" ? null : newRackId;
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: rId });
    setSelectedRack(prev => prev ? { ...prev, devices: prev.devices.filter(d => d.id !== device.id) } : null);
    loadTopology();
  };
```

NEW:
```javascript
  const moveDevice = async (device, newRackId) => {
    const rId = newRackId === "__unassigned__" ? null : newRackId;
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: rId });
    loadTopology();
  };
```

---

## Step 8 — Remove Stale Devices Sync from `loadTopology` (already done in Step 2)

This was handled in Step 2 where `loadTopology` was simplified. No additional change
required here. Confirm that after Step 2 the callback body is:

```javascript
  const loadTopology = useCallback(() => {
    initializedRef.current = true;
    api.get("/api/topology").then(data => {
      setTopology(data);
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);
```

---

## Step 9 — Build `ipToRackId` from Unfiltered Nodes in TopologyMap

**File:** `frontend/src/components/map/TopologyMap.jsx`
**Issue:** 2.5 — `ipToRackId` is derived from the **filtered** `racks` array. When a
class filter hides a device, its IP is absent from `ipToRackId`, so every link involving
that device is silently dropped from `rackLinks` — even though the rack node itself may
still be visible. Links vanish unexpectedly when a user activates any class filter.

**Current code (lines ~93-97):**
```javascript
  const ipToRackId = useMemo(() => {
    const map = {};
    racks.forEach(rack => rack.devices.forEach(d => { map[d.ip] = rack.id; }));
    return map;
  }, [racks]);
```

**Fix:** Build `ipToRackId` from the raw `nodes` prop (unfiltered) together with
`managedRacks` so routing information is always complete. Then keep the existing
`rackLinks` guard (`if (!ra || !rb || ra === rb) return;`) — but now `ra`/`rb` will be
present for all known devices regardless of filters. The link is still only *drawn* when
both `rackById(l.from)` and `rackById(l.to)` return non-null objects from the filtered
`racks` array (existing guard in the render loop).

**Exact change:**

OLD:
```javascript
  const ipToRackId = useMemo(() => {
    const map = {};
    racks.forEach(rack => rack.devices.forEach(d => { map[d.ip] = rack.id; }));
    return map;
  }, [racks]);
```

NEW:
```javascript
  // Build from unfiltered nodes so class/rack filters do not silently drop link routes.
  // Links are only rendered when both rack endpoints are visible (rackById guard below).
  const ipToRackId = useMemo(() => {
    const rackForNode = {};
    (managedRacks || []).forEach(r => { rackForNode[r.id] = r.id; });
    const map = {};
    nodes.forEach(node => {
      const rId = node.rack_id && rackForNode[node.rack_id] ? node.rack_id : "__unassigned__";
      map[node.ip] = rId;
    });
    return map;
  }, [nodes, managedRacks]);
```

**Why this fixes it:**
- `ipToRackId` now covers every known device regardless of active filters.
- `rackLinks` routing keys (`ra`, `rb`) will be populated even when one side is filtered.
- The render step `const ra = rackById(l.from), rb = rackById(l.to); if (!ra || !rb) return null;`
  already filters out links where one rack is hidden, so visual correctness is maintained.

---

## Step 10 — Null Guard in `onMouseUp`

**File:** `frontend/src/components/map/TopologyMap.jsx`
**Issue:** 2.6 — If `rack` is `undefined` when `onMouseUp` fires (fast drag + filter
change in the same render cycle), `rack.devices.forEach(...)` throws, crashing the SVG.

**Current code:**
```javascript
  const onMouseUp = (e, rack) => {
    if (bgPan) { setBgPan(null); return; }
    if (!drag) return;
    if (!drag.moved) {
      onSelectRack(rack);
    } else {
      rack.devices.forEach(d => {
```

**Fix:** Add a null guard for `rack` at the start:

OLD:
```javascript
  const onMouseUp = (e, rack) => {
    if (bgPan) { setBgPan(null); return; }
    if (!drag) return;
    if (!drag.moved) {
      onSelectRack(rack);
    } else {
      rack.devices.forEach(d => {
```

NEW:
```javascript
  const onMouseUp = (e, rack) => {
    if (bgPan) { setBgPan(null); return; }
    if (!drag) return;
    if (!rack) { setDrag(null); return; }
    if (!drag.moved) {
      onSelectRack(rack);
    } else {
      rack.devices.forEach(d => {
```

---

## Step 11 — Null Guard on `d.ports` in TopologyMap

**File:** `frontend/src/components/map/TopologyMap.jsx`
**Issue:** 2.7 — `d.ports.length` and `d.ports.filter(...)` will throw if a stale ETag
cache entry (from before the `ports` field existed) is returned. After Step 1 the
`structuredClone` fix prevents cache pollution, but this defensive guard costs nothing
and protects against any future schema changes.

**Current code (inside the `racks.map` render):**
```javascript
        const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
        const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
```

**Fix:**

OLD:
```javascript
        const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
        const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
```

NEW:
```javascript
        const totalPorts  = rack.devices.reduce((s,d) => s + (d.ports || []).length, 0);
        const activePorts = rack.devices.reduce((s,d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
```

---

## Step 12 — Null Guard on `device.ports` in RackDetail

**File:** `frontend/src/components/map/RackDetail.jsx`
**Issue:** 2.7 (extended) — `RackDetail` performs its own port counting for the header
summary. These lines also need the same defensive guard.

**Current code (lines ~9-10 in RackDetail):**
```javascript
  const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
  const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
```

**Fix:**

OLD:
```javascript
  const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
  const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
```

NEW:
```javascript
  const totalPorts  = rack.devices.reduce((s,d) => s + (d.ports || []).length, 0);
  const activePorts = rack.devices.reduce((s,d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
```

---

## Checklist

- [ ] Step 1 — `api.js`: `structuredClone` on 304 return and on cache store (Issue 2.1)
- [ ] Step 2 — `useTopologyData.js`: set `initializedRef.current = true` in `loadTopology`; remove stale `setSelectedRack` devices sync (Issue 2.1 / 2.2)
- [ ] Step 3 — `api.js`: add `normPort` export; use in `buildPortLinkMap` (Issue 2.4)
- [ ] Step 4 — `SwitchPanel.jsx`: import `normPort`; use `normPort(port.if_descr)` in both `pKey` constructions (Issue 2.4)
- [ ] Step 5 — `Port.jsx`: import `normPort`; use in highlight key construction and `handleClick` identity check (Issue 2.4)
- [ ] Step 6 — `RackDetail.jsx`: import `normPort`; use in `linkColorMap` key construction (Issue 2.4)
- [ ] Step 7 — `MapPage.jsx`: add `selectedRackFull` memo; update `RackDetail` to use `selectedRackFull`; simplify `moveDevice` (Issue 2.2)
- [ ] Step 8 — Verify `useTopologyData.js` `loadTopology` is clean (covered by Step 2)
- [ ] Step 9 — `TopologyMap.jsx`: rebuild `ipToRackId` from unfiltered `nodes` + `managedRacks` (Issue 2.5)
- [ ] Step 10 — `TopologyMap.jsx`: null guard `if (!rack) { setDrag(null); return; }` in `onMouseUp` (Issue 2.6)
- [ ] Step 11 — `TopologyMap.jsx`: `(d.ports || [])` guards in reduce calls (Issue 2.7)
- [ ] Step 12 — `RackDetail.jsx`: `(d.ports || [])` guards in reduce calls (Issue 2.7)

---

## Files Modified Summary

| File | Steps |
|------|-------|
| `frontend/src/api.js` | 1, 3 |
| `frontend/src/hooks/useTopologyData.js` | 2 |
| `frontend/src/components/SwitchPanel.jsx` | 4 |
| `frontend/src/components/Port.jsx` | 5 |
| `frontend/src/components/map/RackDetail.jsx` | 6, 12 |
| `frontend/src/pages/MapPage.jsx` | 7 |
| `frontend/src/components/map/TopologyMap.jsx` | 9, 10, 11 |

---

## Expected Outcomes After All Steps Applied

| Symptom | Root cause fixed | Expected result |
|---------|-----------------|-----------------|
| Port dot indicators never appear | Step 3 + 4 (`normPort`) | Port dots appear for all vendors where LLDP port ID matches ifDescr case-insensitively |
| Cable highlight does not match port | Step 5 + 6 (`normPort`) | Click-to-highlight correctly colours both local and remote port |
| Links disappear after reload (304 race) | Step 1 (`structuredClone`) | Each `loadTopology` returns a fresh object; React state always updates |
| New devices stacked at (100,100) | Step 1 (side-effect: new `nodes` reference always triggers `positions` useEffect) | New racks appear at their stored `map_x/map_y` positions |
| RackDetail shows stale port count after reload | Step 7 (`selectedRackFull` memo) | RackDetail always reflects current `topology.nodes` with zero lag |
| Links vanish when class filter active | Step 9 (`ipToRackId` from unfiltered nodes) | Links remain visible as long as both rack nodes are shown |
| SVG crash on fast drag + filter change | Step 10 (null guard) | `onMouseUp` gracefully exits instead of throwing |
| Crash when `d.ports` is undefined | Steps 11 + 12 (`(d.ports || [])`) | Defensive fallback prevents render crash |
