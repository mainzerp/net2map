# MapPage.jsx Split — Implementation Plan

## Overview

Split `frontend/src/pages/MapPage.jsx` (1126 lines, 5 co-located components + helpers) into
focused, single-responsibility files. No logic changes — pure extraction.

**Target state:**

```
frontend/src/components/map/
    ActiveLinkBar.jsx       ~30 lines
    FilterBar.jsx           ~90 lines
    TopologyMap.jsx         ~310 lines
    RackDetail.jsx          ~470 lines
frontend/src/hooks/
    useTopologyData.js      ~55 lines
    useMapBackground.js     ~35 lines
    useRackOrders.js        ~40 lines
frontend/src/pages/
    MapPage.jsx             ~110 lines  (residual orchestrator)
```

---

## Step 1 — Create Directory Structure

Create the following directories (they do not yet exist):

```
frontend/src/components/map/
frontend/src/hooks/
```

Use `mkdir -p` (or equivalent). Do NOT create any files yet.

---

## Step 2 — Create `frontend/src/components/map/ActiveLinkBar.jsx`

**Component name:** `ActiveLinkBar` (named export AND default export)

**Responsibility:** Pure presentational strip. Currently orphaned in MapPage.jsx (not rendered
anywhere). Extract now for forward compatibility.

**Imports required:**
```jsx
// none — no external imports needed
```

**Exact prop signature:**
```jsx
function ActiveLinkBar({ link, color, onClear })
```

| Prop | Type | Description |
|---|---|---|
| `link` | `{ local_ip: string, local_port: string, remote_ip: string, remote_port: string, speed_label: string }` | The active connection to display |
| `color` | `string` | Accent hex color string (e.g. `"#22d3ee"`) |
| `onClear` | `() => void` | Called when the X button is clicked |

**Content:** Copy lines 5–28 of the current `MapPage.jsx` verbatim (the `ActiveLinkBar` function
body). Export as both named and default:

```jsx
export { ActiveLinkBar };
export default ActiveLinkBar;
```

**No state. No hooks.**

---

## Step 3 — Create `frontend/src/components/map/FilterBar.jsx`

**Component name:** `FilterBar` (default export)

**Responsibility:** Renders rack and switch-class toggle buttons above the topology map. Stateless
— all toggle state lives in the parent (`MapPage`).

**Imports required:**
```jsx
// none — no external imports needed
```

**Exact prop signature:**
```jsx
function FilterBar({ racks, classes, filters, onFilterChange })
```

| Prop | Type | Description |
|---|---|---|
| `racks` | `Array<{ id: number\|string, label: string }>` | All rack objects from topology |
| `classes` | `Array<{ id: number\|string, label: string, color: string }>` | All switch-class objects from topology |
| `filters` | `{ racks: Set\|null, classes: Set\|null }` | Current filter state from parent |
| `onFilterChange` | `(updater: Function \| object) => void` | Setter — accepts either a plain object or updater function (same API as React `setState`) |

**Content:** Copy lines 31–115 of the current `MapPage.jsx` verbatim (the `FilterBar` function
body and internal `toggleRack`, `toggleClass`, `clearFilters`, `hasFilters`, `btnStyle` helpers).

**Export:**
```jsx
export default FilterBar;
```

**No state. No hooks.**

---

## Step 4 — Create `frontend/src/components/map/TopologyMap.jsx`

**Component name:** `TopologyMap` (default export)

**Responsibility:** SVG canvas rendering rack nodes as draggable boxes and inter-rack links as
lines. Handles viewport zoom (wheel), pan (background drag), rack drag-to-reposition, rack
selection, and optional background image layer.

**Imports required:**
```jsx
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
```

**Helper function** (move into this file, NOT into a separate utils file):
```jsx
function _isValidZoom(z) { ... }
```
Copy the exact body from lines 118–126 of `MapPage.jsx`.

**Exact prop signature:**
```jsx
function TopologyMap({
  nodes,
  links,
  managedRacks,
  switchClasses,
  filters,
  onSelectRack,
  selectedRackId,
  onPositionChange,
  mapBgUrl,
  mapBgOpacity,
  mapBgScale,
  mapBgNat,
})
```

| Prop | Type | Description |
|---|---|---|
| `nodes` | `Array<Node>` | Device nodes from topology (`topology.nodes`) |
| `links` | `Array<Link>` | All topology links (`topology.links`) |
| `managedRacks` | `Array<{ id, label, room, ... }>` | Rack objects from topology (`topology.racks`) |
| `switchClasses` | `Array<{ id, label, color }>` | Switch class objects (`topology.classes`) |
| `filters` | `{ racks: Set\|null, classes: Set\|null }` | Current filter state |
| `onSelectRack` | `(rack: RackSummary) => void` | Called on rack click (without drag) |
| `selectedRackId` | `number\|string\|null` | ID of the currently selected rack (for highlight) |
| `onPositionChange` | `(id: number, x: number, y: number) => void` | Called after drag drop to persist position |
| `mapBgUrl` | `string\|null` | URL for background image |
| `mapBgOpacity` | `number` | Opacity of bg image (0–1) |
| `mapBgScale` | `number` | Scale multiplier for bg image box |
| `mapBgNat` | `{ w: number, h: number }\|null` | Natural dimensions of bg image for aspect-ratio fit |

**Internal state (owned entirely by this component):**

| Variable | Initial value | Description |
|---|---|---|
| `drag` | `null` | Current drag target: `{ rackId, devices, ox, oy, moved }` |
| `positions` | `{}` | Map of `deviceId → { x, y }`, synced from `nodes` prop on node change |
| `zoom` | from localStorage `netmap-zoom` or `{ scale:1, tx:0, ty:0 }` | SVG viewport transform |
| `bgPan` | `null` | Background pan: `{ startX, startY, startTx, startTy }` |

**Content:** Copy lines 127–420 of the current `MapPage.jsx` verbatim (the full `TopologyMap`
function body including all `useMemo`, `useCallback`, `useRef`, `useEffect`, event handlers, and
the full JSX `return`).

**Export:**
```jsx
export default TopologyMap;
```

---

## Step 5 — Create `frontend/src/components/map/RackDetail.jsx`

**Component name:** `RackDetail` (default export)

**Responsibility:** Slide-in side panel showing all devices inside the selected rack. Renders
device groups (TOR / Access / Other) with reorder arrows, intra-rack uplinks and trunks as
clickable link rows, inter-rack external links table, cable map legend, and a fixed-position SVG
line overlay drawn between two highlighted port DOM nodes.

**Imports required:**
```jsx
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap } from "../../api.js";
import SwitchPanel from "../SwitchPanel.jsx";
```

**Exact prop signature:**
```jsx
function RackDetail({
  rack,
  allRacks,
  switchClasses,
  switchModels,
  topologyLinks,
  deviceOrder,
  onReorder,
  onClose,
  onRename,
  onMoveDevice,
  onUpdateDeviceMeta,
})
```

| Prop | Type | Description |
|---|---|---|
| `rack` | `{ id: number\|string, label: string, location: string, devices: Array<Device> }` | The selected rack object with its devices array |
| `allRacks` | `Array<{ id, label, room, description, devices }>` | All racks (used for move-device dropdown and external link labels) |
| `switchClasses` | `Array<{ id, label, color }>` | Switch class definitions |
| `switchModels` | `Array<{ id, label, ... }>` | Switch model definitions |
| `topologyLinks` | `Array<Link>` | All topology links (used to compute uplinks, trunks, external) |
| `deviceOrder` | `{ tor?: string[], access?: string[], other?: string[] }` | Pre-computed order arrays per group (keyed by group name, not rack) |
| `onReorder` | `(deviceId: number, direction: "up"\|"down", groupKey: string) => void` | Called when reorder arrow clicked |
| `onClose` | `() => void` | Called when panel X button clicked |
| `onRename` | `(newName: string) => void` | Called after user commits a rack rename |
| `onMoveDevice` | `(device: Device, newRackId: number\|string) => void` | Called when user moves a device to another rack |
| `onUpdateDeviceMeta` | `(device: Device, patch: object) => void` | Called when SwitchPanel emits a metadata update |

**Internal state (owned entirely by this component):**

| Variable | Initial value | Description |
|---|---|---|
| `editing` | `false` | Whether rack label rename input is shown |
| `nameInput` | `rack.label` | Controlled value for rename input |
| `selectedLink` | `null` | The highlighted intra-rack link object |
| `linkLine` | `null` | `{ x1, y1, x2, y2, clipTop }` for the fixed SVG cable overlay |

**Internal refs:**

| Ref | Attached to |
|---|---|
| `scrollRef` | The scrollable content `<div>` |
| `panelHeaderRef` | The panel header `<div>` (used for `clipTop` calculation) |

**Content:** Copy lines 422–870 of the current `MapPage.jsx` verbatim (the full `RackDetail`
function body including all `useMemo`, `useCallback`, `useEffect`, internal helpers
`commitRename`, `sortGroup`, `toggleLink`, `renderGroup`, `renderLink`, and the full JSX
`return`).

**Export:**
```jsx
export default RackDetail;
```

---

## Step 6 — Create `frontend/src/hooks/useTopologyData.js`

**Hook name:** `useTopologyData` (named export)

**Responsibility:** Encapsulates all topology data fetching, the `selectedRack` state with
sessionStorage persistence, and the `loadTopology` reload callback.

**Imports required:**
```js
import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../api.js";
```

**Returns:**
```js
{ topology, selectedRack, setSelectedRack, loadError, loadTopology }
```

| Return value | Type | Description |
|---|---|---|
| `topology` | `{ nodes, links, racks, classes, models }` | Full topology data from `/api/topology` |
| `selectedRack` | `object\|null` | Currently selected rack (with `devices` array) |
| `setSelectedRack` | `React.Dispatch` | Raw setter — needed by MapPage for close/clear actions |
| `loadError` | `string\|null` | Error string if initial load failed |
| `loadTopology` | `() => void` | Callback to re-fetch topology and sync `selectedRack.devices` |

**Exact implementation** (copy from MapPage.jsx lines 872–936, with minor rename of
`setTopology`, `setSelectedRack`, etc. to remain internal):

```js
export function useTopologyData() {
  const [topology, setTopology] = useState({ nodes: [], links: [], racks: [], classes: [] });
  const [selectedRack, setSelectedRack] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const initializedRef = useRef(false);

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
        const id = Number(savedId);
        const rack = (data.racks || []).find(r => r.id === id);
        if (rack) {
          const devices = data.nodes.filter(n => n.rack_id === id);
          setSelectedRack({
            id: rack.id,
            label: rack.label,
            location: rack.location || `${rack.label}${rack.room ? " / " + rack.room : ""}`,
            devices,
          });
        } else {
          sessionStorage.removeItem("selectedRackId");
        }
      }
      initializedRef.current = true;
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);

  // Persist selectedRack to sessionStorage (skip before initial load completes)
  useEffect(() => {
    if (!initializedRef.current) return;
    if (selectedRack) sessionStorage.setItem("selectedRackId", String(selectedRack.id));
    else sessionStorage.removeItem("selectedRackId");
  }, [selectedRack]);

  return { topology, selectedRack, setSelectedRack, loadError, loadTopology };
}
```

**IMPORTANT DIFFERENCE from original:** The `loadTopology` callback uses functional `setState`
for `selectedRack` update instead of closing over `selectedRack`. This removes the
`[selectedRack]` dependency that caused the original to re-create the callback on every rack
selection. This is a safe improvement — same behaviour, better reference stability.

---

## Step 7 — Create `frontend/src/hooks/useMapBackground.js`

**Hook name:** `useMapBackground` (named export)

**Responsibility:** Fetches the map background image URL, natural dimensions, and display
settings (opacity, scale).

**Imports required:**
```js
import { useState, useCallback, useEffect } from "react";
import { api, API } from "../api.js";
```

**Returns:**
```js
{ mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale }
```

| Return value | Type | Description |
|---|---|---|
| `mapBgUrl` | `string\|null` | Full URL to map background image (cache-busted on load) |
| `mapBgNat` | `{ w: number, h: number }\|null` | Natural pixel dimensions of background image |
| `mapBgOpacity` | `number` | Opacity value from `/api/map-settings` (default `0.3`) |
| `mapBgScale` | `number` | Scale value from `/api/map-settings` (default `1`) |

**Exact implementation** (copy from MapPage.jsx lines 937–960):

```js
export function useMapBackground() {
  const [mapBgUrl, setMapBgUrl] = useState(null);
  const [mapBgNat, setMapBgNat] = useState(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);

  const loadMapBg = useCallback(() => {
    fetch(`${API}/api/map-background`, { method: "GET" })
      .then(r => {
        if (r.ok) {
          const url = `${API}/api/map-background?v=${Date.now()}`;
          setMapBgUrl(url);
          const img = new Image();
          img.onload = () => setMapBgNat({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => setMapBgNat(null);
          img.src = url;
        } else {
          setMapBgUrl(null);
          setMapBgNat(null);
        }
      })
      .catch(() => { setMapBgUrl(null); setMapBgNat(null); });
  }, []);

  const loadMapSettings = useCallback(() => {
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
    }).catch(console.error);
  }, []);

  useEffect(() => { loadMapBg(); }, []);
  useEffect(() => { loadMapSettings(); }, []);

  return { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale };
}
```

---

## Step 8 — Create `frontend/src/hooks/useRackOrders.js`

**Hook name:** `useRackOrders` (named export)

**Responsibility:** Maintains the localStorage-persisted device sort order for each rack+group
combination. Provides `reorderDevice` mutator.

**Imports required:**
```js
import { useState } from "react";
```

**Parameters:**
```js
useRackOrders(selectedRack)
```

| Parameter | Type | Description |
|---|---|---|
| `selectedRack` | `object\|null` | The currently selected rack — needed for `reorderDevice` to know which rack's order to update |

**Returns:**
```js
{ rackOrders, reorderDevice }
```

| Return value | Type | Description |
|---|---|---|
| `rackOrders` | `object` | Map of `"${rackId}::${groupKey}" → string[]` (device ID arrays) |
| `reorderDevice` | `(deviceId: number, direction: "up"\|"down", groupKey: string) => void` | Mutates order and persists to localStorage |

**Exact implementation** (copy from MapPage.jsx lines 1001–1033):

```js
export function useRackOrders(selectedRack) {
  const [rackOrders, setRackOrders] = useState(() => {
    try { return JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"); }
    catch { return {}; }
  });

  const reorderDevice = (deviceId, direction, groupKey) => {
    if (!selectedRack) return;
    const rackId = selectedRack.id;
    const devs = selectedRack.devices.filter(d =>
      groupKey === "tor"    ? (d.class_id === 1 || (!d.class_id && d.vendor === "fs")) :
      groupKey === "access" ? (d.class_id === 2 || (!d.class_id && d.vendor === "aruba_cx")) :
      d.class_id == null && d.vendor !== "fs" && d.vendor !== "aruba_cx"
    );
    const ids = devs.map(d => d.id);
    const storeKey = `${rackId}::${groupKey}`;
    const order = (rackOrders[storeKey]) || [];
    const sorted = [...ids].sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const idx = sorted.indexOf(deviceId);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    [sorted[idx], sorted[newIdx]] = [sorted[newIdx], sorted[idx]];
    const newOrders = { ...rackOrders, [storeKey]: sorted };
    setRackOrders(newOrders);
    localStorage.setItem("netmap_rack_orders", JSON.stringify(newOrders));
  };

  return { rackOrders, reorderDevice };
}
```

---

## Step 9 — Rewrite `frontend/src/pages/MapPage.jsx`

Replace the entire file content. The new MapPage.jsx is a pure orchestrator of ~110 lines.

### 9a. New imports block

```jsx
import { useMemo } from "react";
import { api } from "../api.js";
import FilterBar from "../components/map/FilterBar.jsx";
import TopologyMap from "../components/map/TopologyMap.jsx";
import RackDetail from "../components/map/RackDetail.jsx";
import { useTopologyData } from "../hooks/useTopologyData.js";
import { useMapBackground } from "../hooks/useMapBackground.js";
import { useRackOrders } from "../hooks/useRackOrders.js";
```

Note: `useState` and `useCallback` are no longer needed at MapPage level (they are inside the
hooks). `useRef`, `useEffect` are also not needed at this level.

### 9b. State / hooks wiring inside MapPage

```jsx
export default function MapPage() {
  const { topology, selectedRack, setSelectedRack, loadError, loadTopology } = useTopologyData();
  const { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale } = useMapBackground();
  const { rackOrders, reorderDevice } = useRackOrders(selectedRack);

  const [filters, setFilters] = useState({ racks: null, classes: null });
```

Wait — `filters` state stays in MapPage because it is passed to both `FilterBar` and
`TopologyMap`. It is not fetched or persisted, so it does not belong in a custom hook.
Therefore MapPage **does** still need `useState` from React:

```jsx
import { useState, useMemo } from "react";
```

### 9c. `allRacks` useMemo (stays in MapPage)

The `allRacks` computation (lines 966–982 of original) stays in MapPage because it is derived
from `topology` (owned by `useTopologyData`) and is passed directly to `RackDetail`:

```jsx
const allRacks = useMemo(() => {
  const rackMap = {};
  (topology.racks || []).forEach(r => {
    rackMap[r.id] = { id: r.id, label: r.label, room: r.room, description: r.description, devices: [] };
  });
  const unassigned = { id: "__unassigned__", label: "Unassigned", room: "", description: "", devices: [] };
  topology.nodes.forEach(n => {
    if (n.rack_id && rackMap[n.rack_id]) {
      rackMap[n.rack_id].devices.push(n);
    } else {
      unassigned.devices.push(n);
    }
  });
  const result = Object.values(rackMap);
  if (unassigned.devices.length > 0) result.push(unassigned);
  return result;
}, [topology.nodes, topology.racks]);
```

### 9d. API mutation callbacks (stay in MapPage)

Copy the following from the original MapPage.jsx verbatim (lines 983–1000):

```jsx
const savePosition = (id, x, y) => {
  api.patch(`/api/topology/devices/${id}/position`, { map_x: x, map_y: y }).catch(console.error);
};

const renameRack = async (rack, newName) => {
  if (rack.id === "__unassigned__") return;
  await api.put(`/api/racks/${rack.id}`, { label: newName });
  setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
  loadTopology();
};

const moveDevice = async (device, newRackId) => {
  const rId = newRackId === "__unassigned__" ? null : newRackId;
  await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: rId });
  setSelectedRack(prev => prev ? { ...prev, devices: prev.devices.filter(d => d.id !== device.id) } : null);
  loadTopology();
};

const updateDeviceMeta = async (device, patch) => {
  await api.patch(`/api/topology/devices/${device.id}/meta`, patch);
  loadTopology();
};
```

### 9e. Render JSX (stays in MapPage)

Copy the render return block from lines 1038–1126 of original verbatim. This includes:
- `loadError` banner
- Map toolbar div (switch/link counts + Reload button)
- `<FilterBar>` usage
- `<TopologyMap>` usage
- `<RackDetail>` usage (conditional on `selectedRack`)

The `deviceOrder` prop construction for `RackDetail` remains identical:
```jsx
deviceOrder={selectedRack ? Object.fromEntries(
  ["tor","access","other"].map(g => [g, rackOrders[`${selectedRack.id}::${g}`]])
) : {}}
```

### 9f. Removed from MapPage.jsx

The following are **deleted entirely** from `MapPage.jsx` after this step:
- `function ActiveLinkBar(...)` (lines 5–28)
- `function FilterBar(...)` (lines 31–115)
- `function _isValidZoom(...)` (lines 118–126)
- `function TopologyMap(...)` (lines 127–420)
- `function RackDetail(...)` (lines 422–870)
- All state variables now in hooks: `topology`, `selectedRack`, `loadError`, `initializedRef`, `mapBgUrl`, `mapBgNat`, `mapBgOpacity`, `mapBgScale`, `rackOrders`
- All callbacks now in hooks: `loadTopology`, `loadMapBg`, `loadMapSettings`, `reorderDevice`
- All `useEffect` calls related to the above

---

## Step 10 — Build Verification

After all file edits are complete:

1. Run `docker compose exec frontend sh -c "cd /app && npm run build"` from the workspace root,
   OR run `npm run build` inside `frontend/` directly.

2. The build **must complete with exit code 0** and **zero errors**.

3. Acceptable: Vite "chunk size" warnings — these are not errors.

4. If build fails, check:
   - Import paths are correct (relative paths use `../../api.js` from `components/map/`, `../api.js` from `hooks/`)
   - `SwitchPanel` import in `RackDetail.jsx` uses `../SwitchPanel.jsx` (one level up from `components/map/`)
   - `useState` is imported in `MapPage.jsx` (needed for `filters` state)
   - No residual references to the removed inline components remain in `MapPage.jsx`

---

## State Ownership Summary After Split

| State variable | Lives in | Passed to |
|---|---|---|
| `topology` | `useTopologyData` | MapPage → TopologyMap, RackDetail (via allRacks) |
| `selectedRack` | `useTopologyData` | MapPage → RackDetail, useRackOrders |
| `loadError` | `useTopologyData` | MapPage render only |
| `filters` | `MapPage` | FilterBar, TopologyMap |
| `mapBgUrl` | `useMapBackground` | MapPage → TopologyMap |
| `mapBgNat` | `useMapBackground` | MapPage → TopologyMap |
| `mapBgOpacity` | `useMapBackground` | MapPage → TopologyMap |
| `mapBgScale` | `useMapBackground` | MapPage → TopologyMap |
| `rackOrders` | `useRackOrders` | MapPage computes `deviceOrder` prop → RackDetail |
| `drag` | `TopologyMap` internal | — |
| `positions` | `TopologyMap` internal | — |
| `zoom` | `TopologyMap` internal | — |
| `bgPan` | `TopologyMap` internal | — |
| `editing` | `RackDetail` internal | — |
| `nameInput` | `RackDetail` internal | — |
| `selectedLink` | `RackDetail` internal | — |
| `linkLine` | `RackDetail` internal | — |

---

## Checklist

- [ ] Step 1: Create `frontend/src/components/map/` directory
- [ ] Step 1: Create `frontend/src/hooks/` directory
- [ ] Step 2: Create `frontend/src/components/map/ActiveLinkBar.jsx`
- [ ] Step 3: Create `frontend/src/components/map/FilterBar.jsx`
- [ ] Step 4: Create `frontend/src/components/map/TopologyMap.jsx` (includes `_isValidZoom`)
- [ ] Step 5: Create `frontend/src/components/map/RackDetail.jsx`
- [ ] Step 6: Create `frontend/src/hooks/useTopologyData.js`
- [ ] Step 7: Create `frontend/src/hooks/useMapBackground.js`
- [ ] Step 8: Create `frontend/src/hooks/useRackOrders.js`
- [ ] Step 9: Overwrite `frontend/src/pages/MapPage.jsx` with orchestrator-only version
- [ ] Step 10: Run `npm run build` — confirm zero errors
