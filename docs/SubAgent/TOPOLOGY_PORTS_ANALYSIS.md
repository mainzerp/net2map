# Topology Ports & Links Rendering - Bug Analysis

**Date:** 2026-02-24
**Scope:** Frontend topology map - intermittent missing ports and links

---

## 1. Executive Summary

After a full read of all relevant files, five distinct root-cause categories were found that can individually or in combination cause ports and/or rack-to-rack links to not appear intermittently:

1. **ETag / HTTP 304 cache returning stale data after a scan** - the most likely cause of "it was there, now it's gone" reports
2. **`selectedRack` object not refreshed after `loadTopology()`** - RackDetail shows stale port data
3. **`positions` state initialised from stale `nodes` prop** - rack nodes can render at (0,0) or stack, hiding links
4. **`portLinkMap` key uses `if_descr` while `TopologyLink` rows store `local_port` / `remote_port`** - port dot indicators never appear for some topologies
5. **`rackLinks` silently drops links when either endpoint IP is not in a visible rack** - links disappear under active rack/class filters

Each issue is described in detail below with the exact file and line range, and a recommended fix.

---

## 2. Issue Details

### 2.1 ETag Cache Returning Stale Topology After Scan

**File:** `frontend/src/api.js` — `api.get()` function  
**File:** `frontend/src/hooks/useTopologyData.js` — `loadTopology()` callback

**Description:**

`api.get()` maintains an in-memory ETag cache (`_etagCache`). On a cache hit (HTTP 304) it returns the **cached JavaScript object** from the previous response. After a scan finishes, `loadTopology()` is called. If the backend returns 304 (content unchanged since last fetch — which can happen if a second reload fires quickly, e.g. via a polling interval or a double-click on the reload button), the old data is returned silently, showing zero new ports / links even though the DB was updated.

The deeper problem is that the cache object is **mutated nowhere** — but its identity is shared. If some code mutates the cached `data` object (e.g. via React state merging), later callers get the mutated version.

Additionally, `loadTopology()` in `useTopologyData.js` is the *reload* path but `initializedRef` is only set in the *initial load* `useEffect`. If the reload path is the first call to complete (race condition during mount), `initializedRef` stays `false` and the `selectedRack` persistence effect is suppressed — meaning a re-render after reload can clear the rack selection.

**Recommended Fix:**

- In `api.get()`, deep-clone cached data before returning it: `return structuredClone(_etagCache[path].data)` — this prevents shared-object mutation bugs.
- In `useTopologyData.js`, set `initializedRef.current = true` inside the `loadTopology` callback as well (or replace the ref with a state boolean that is initialised once either path completes).

---

### 2.2 `selectedRack` Devices Not Refreshed After `loadTopology()` When Rack Is Open

**File:** `frontend/src/hooks/useTopologyData.js` — `loadTopology` callback  
**File:** `frontend/src/pages/MapPage.jsx` — `moveDevice`, `renameRack`, `updateDeviceMeta`

**Description:**

When `loadTopology()` fires (e.g. after `moveDevice` or `updateDeviceMeta`), `setSelectedRack` updates `prev.devices` by filtering `data.nodes` by `rack_id`. This looks correct, but there is a subtle flaw: the **`RackDetail` component receives `rack={selectedRack}`**, and the `rack.devices` list is rebuilt from `data.nodes`. However `data.nodes` at this point may still be the ETag-cached version (Issue 2.1). If the cache was not busted, the same old node objects (with old port counts, old link data) are handed back to `RackDetail`.

Separately, the `allRacks` memo in `MapPage.jsx` is recomputed from `topology.nodes` and `topology.racks`, but `selectedRack` is **separate state** updated manually. These two can diverge: `allRacks` reflects the latest topology, while `selectedRack.devices` may be one render cycle behind.

**Recommended Fix:**

- Derive `selectedRack.devices` directly from `topology.nodes` via a `useMemo` in `MapPage.jsx` rather than storing them inside the `selectedRack` state object. Keep `selectedRack` as `{ id, label, location }` only; compute `.devices` on the fly from `topology.nodes`.

---

### 2.3 `positions` State Not Reset When `nodes` Identity Changes After Reload

**File:** `frontend/src/components/map/TopologyMap.jsx` — lines 36-38

```jsx
useEffect(() => {
  const pos = {};
  nodes.forEach(n => { pos[n.id] = { x: n.map_x, y: n.map_y }; });
  setPositions(pos);
}, [nodes]);
```

**Description:**

This `useEffect` depends on the `nodes` array reference. `nodes` is `topology.nodes` from state. After `loadTopology()` resolves, `setTopology(data)` creates a new state object, which means `topology.nodes` is a new array reference — the effect **should** re-run.

However, if the ETag cache returns the **same object reference** (Issue 2.1 — before the `structuredClone` fix), `topology.nodes` will be the exact same array object as before, React will see no change in props, and the `useEffect` will not re-run. Any device that was moved (position changed in DB since last full fetch) will remain at its old screen position. More critically, **new devices added by a scan will have `positions[n.id] = undefined`**, causing `positions[d.id]?.x` to be `undefined` and `getRackCenter` to fall back to `d.map_x` — which defaults to `100.0` for all new devices, stacking all new racks on top of each other at `(100, 100)`.

When multiple racks stack at the same coordinates, `getRackCenter` returns the same point for many racks, making their `rackLinks` lines render as zero-length (invisible).

**Recommended Fix:**

- Ensure `api.get()` always returns a new object (structuredClone fix from Issue 2.1).
- Alternatively, add a `key` prop to `TopologyMap` tied to `topology` identity, or handle `positions[d.id] === undefined` explicitly in `getRackCenter` by falling back to a spread-out grid layout instead of `(100, 100)`.

---

### 2.4 Port Link Dot Key Mismatch: `if_descr` vs `local_port`/`remote_port`

**File:** `frontend/src/components/SwitchPanel.jsx` — port key construction  
**File:** `frontend/src/api.js` — `buildPortLinkMap()`  
**File:** `backend/database.py` — `TopologyLink` model

**Description:**

In `SwitchPanel.jsx`, each port's lookup key is built as:

```jsx
const pKey = `${device.ip}:${port.if_descr}`;
```

In `buildPortLinkMap()` in `api.js`, the map keys are built as:

```js
m[`${l.local_ip}:${l.local_port}`]   = { link: l, role: "from" };
m[`${l.remote_ip}:${l.remote_port}`] = { link: l, role: "to"   };
```

The `TopologyLink` DB model stores:

```python
local_port  = Column(String, default="")  # populated by LLDP scanner
remote_port = Column(String, default="")
```

The SNMP scanner populates `local_port` and `remote_port` from **LLDP port IDs**, which are typically interface descriptions like `"1/1/1"` or `"GigabitEthernet0/1"`. The `port.if_descr` field on a `Port` row is the SNMP `ifDescr`, which may be a different format (e.g. `"GigabitEthernet1"` vs `"gi1"` vs `"1/1/1"`).

**If `local_port` and `if_descr` do not match exactly**, `portLinkMap[pKey]` will always be `null`, the port dot indicator will never appear, and clicking ports will do nothing. This is a silent, topology-dependent failure — it only manifests when the LLDP port ID format differs from ifDescr, which varies by vendor.

**Evidence:** The `Port` component checks `const linkEntry = portLinkMap && portKey ? portLinkMap[portKey] : null` — if this is always null, no port is ever highlighted as linked, even when inter-switch links exist.

**Recommended Fix:**

- Normalise both keys to the same canonical form. In the scanner (`snmp_scanner.py`), store `local_port` as the exact `if_descr` of the matching port object (looked up by `if_index` or name) rather than the raw LLDP port ID string.
- Alternatively, add a secondary lookup in `buildPortLinkMap()` that indexes by both the LLDP port ID and the ifDescr (requires the backend to send both fields in `TopologyLinkOut`).
- Short-term: add normalisation (lowercase, strip whitespace) to both the key construction in `SwitchPanel` and `buildPortLinkMap`.

---

### 2.5 `rackLinks` Silently Drops Links Under Rack/Class Filters

**File:** `frontend/src/components/map/TopologyMap.jsx` — `rackLinks` memo and `ipToRackId` memo

**Description:**

`ipToRackId` is built from the **filtered** `racks` array (after rack/class filters are applied):

```jsx
const ipToRackId = useMemo(() => {
  const map = {};
  racks.forEach(rack => rack.devices.forEach(d => { map[d.ip] = rack.id; }));
  return map;
}, [racks]);
```

`rackLinks` then does:

```jsx
links.forEach(l => {
  const ra = ipToRackId[l.local_ip];
  const rb = ipToRackId[l.remote_ip];
  if (!ra || !rb || ra === rb) return;   // <- silently dropped
  ...
```

If the user has applied a rack filter that hides one endpoint of a link, `ipToRackId[l.remote_ip]` will be `undefined` and the entire link group is dropped. This is correct UX behaviour (don't show links to hidden racks), but it can be surprising when a class filter hides one device class within a rack — the rack is still visible but all its links to the filtered-out class become invisible. The `racks` array is filtered by `filters.classes` in the `racks` memo, so a device class filter effectively makes links to those devices invisible even though the rack node is still drawn.

**Recommended Fix:**

- Build `ipToRackId` from `nodes` directly (the unfiltered node list) so that link routing is always available, and only suppress drawing a link when **both** racks are visible. When only one rack endpoint is visible, draw a "stub" line or omit gracefully but do not silently break the visible rack's link count.

---

### 2.6 `TopologyMap` `onMouseUp` Does Not Guard Against Missing `rack`

**File:** `frontend/src/components/map/TopologyMap.jsx` — `onMouseUp` handler and outer SVG `onMouseUp`

**Description:**

The outer SVG has:

```jsx
onMouseUp={() => { setDrag(null); setBgPan(null); }}
```

The rack `<g>` element has:

```jsx
onMouseUp={e => onMouseUp(e, rack)}
```

Inside `onMouseUp`:

```jsx
if (!drag.moved) {
  onSelectRack(rack);
} else {
  rack.devices.forEach(d => { ... });
}
```

If `rack` is undefined (e.g. the rack was removed from the filtered list during a drag in the same render cycle), `rack.devices` will throw. While not a direct cause of missing ports, this unhandled exception can crash the SVG render and blank the entire map until a reload.

**Recommended Fix:**

- Add a null guard: `if (!rack) { setDrag(null); return; }` at the start of `onMouseUp`.

---

### 2.7 `SwitchPanel` Port Rendering: Empty `ports` Array Is Not Guarded in `TopologyMap`

**File:** `frontend/src/components/map/TopologyMap.jsx` — rack node render

```jsx
const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
```

**Description:**

`d.ports` is assumed to always be an array. In `DeviceOut`, `ports: List[PortOut] = []` defaults to an empty list, so the backend should always send an array. However, if the ETag cache returns a response that was stored before the `ports` field existed (e.g. a very old cache entry from a schema migration), `d.ports` could be `undefined`, causing `d.ports.length` to throw and crashing the entire SVG render.

**Recommended Fix:**

- Defensive guard: `(d.ports || []).length` in both reduce calls in `TopologyMap`.
- Also in `SwitchPanel.jsx`: `device.ports.length > 0` already implies truthy, but the `activePorts` line `device.ports.filter(...)` would throw if `device.ports` were `undefined`. Add `(device.ports || [])` there too.

---

## 3. Data Flow Summary

```
Backend /api/topology
    └── nodes: Device[] (with ports[] embedded via lazy="selectin")
    └── links: TopologyLink[]
    └── racks: Rack[]
    └── classes: SwitchClass[]

api.get("/api/topology")          ← ETag cache (Issue 2.1)
    └── useTopologyData.js
        └── topology state {nodes, links, racks, classes}
        └── selectedRack state   ← can diverge from topology (Issue 2.2)

MapPage.jsx
    └── allRacks memo             ← from topology.nodes + topology.racks
    └── TopologyMap props: nodes, links, managedRacks, switchClasses
    └── RackDetail props: rack (selectedRack), topologyLinks

TopologyMap.jsx
    └── racks memo                ← filtered, from nodes + managedRacks (Issue 2.5)
    └── positions state           ← from nodes useEffect (Issue 2.3)
    └── ipToRackId memo           ← from filtered racks (Issue 2.5)
    └── rackLinks memo            ← drops links with hidden endpoints (Issue 2.5)
    └── getRackCenter             ← uses positions || map_x/map_y

RackDetail.jsx
    └── portLinkMap               ← buildPortLinkMap(allIntraLinks)
    └── SwitchPanel per device
        └── Port per port
            └── portLinkMap[`${device.ip}:${port.if_descr}`] (Issue 2.4)
```

---

## 4. Priority Matrix

| # | Issue | Severity | Frequency | Effort to Fix |
|---|-------|----------|-----------|---------------|
| 2.4 | Port key mismatch (`if_descr` vs LLDP port ID) | High | Always (vendor-dependent) | Medium |
| 2.1 | ETag cache returning stale data / shared object | High | Intermittent | Low |
| 2.2 | `selectedRack.devices` diverges from `topology.nodes` | Medium | After each scan/reload | Low |
| 2.3 | `positions` not reset on same-reference `nodes` | Medium | After ETag 304 | Low (fixed by 2.1) |
| 2.5 | `rackLinks` drops links under class filter | Medium | When class filter active | Low |
| 2.6 | `onMouseUp` no null guard for missing rack | Low | Race during fast drag+reload | Low |
| 2.7 | `d.ports` undefined guard missing | Low | Only after schema change | Low |

---

## 5. Recommended Fix Order

1. **Fix Issue 2.1** (ETag cache `structuredClone`) — resolves 2.3 as a side-effect, prevents stale data bugs across the board.
2. **Fix Issue 2.4** (port key normalisation) — highest user-visible impact; port dots and cable highlights never work when LLDP port IDs differ from ifDescr.
3. **Fix Issue 2.2** (derive `selectedRack.devices` from `topology.nodes` memo) — eliminates the one-cycle lag in RackDetail after reload.
4. **Fix Issue 2.5** (build `ipToRackId` from unfiltered `nodes`) — prevents links disappearing under class filters.
5. **Fix Issues 2.6 and 2.7** (null guards) — small defensive hardening.
