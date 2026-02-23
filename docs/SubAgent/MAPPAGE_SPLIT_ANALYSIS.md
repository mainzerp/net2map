# MapPage.jsx Split Analysis

## File Stats

- **Path:** `frontend/src/pages/MapPage.jsx`
- **Line count:** 1126 lines
- **Current structure:** 5 co-located components + 1 helper function, all in one file

---

## Current Structure Outline

```
MapPage.jsx
├── ActiveLinkBar           (lines 5–28)     ~24 lines
├── FilterBar               (lines 31–115)   ~85 lines
├── _isValidZoom()          (lines 118–126)  ~9 lines   [helper]
├── TopologyMap             (lines 127–420)  ~295 lines
├── RackDetail              (lines 422–870)  ~450 lines
└── MapPage (default export)(lines 872–1126) ~255 lines
```

---

## Logical Sections / Responsibilities

### 1. ActiveLinkBar (lines 5–28)
Displays a highlighted connection bar strip above the rack detail content when a port/link is selected in the topology view (not currently used in MapPage render directly; it is actually unused in MapPage — it renders inside `RackDetail` child SwitchPanel through port clicks, but the bar itself is not mounted at the MapPage level).

**Correction:** On re-read, `ActiveLinkBar` is defined but **not actually rendered** anywhere in MapPage.jsx. It is an orphaned component left over from an earlier design. The selected-link display is embedded directly in `RackDetail`.

### 2. FilterBar (lines 31–115)
Renders a row of toggle buttons to filter visible racks and switch classes on the topology map.
- Holds no state of its own — all state is owned by the parent (`MapPage`)
- Exposes `onFilterChange` setter callback

### 3. TopologyMap (lines 127–420)
SVG canvas drawing rack nodes as draggable boxes, inter-rack links as lines, optional background image layer. Handles:
- Viewport zoom (wheel) and pan (background drag) — zoom persisted to `localStorage`
- Rack node drag-to-reposition
- Rack selection (click without drag)
- Background image fit / scale / opacity

### 4. RackDetail (lines 422–870)
Slide-in side panel showing all devices inside a selected rack. Handles:
- Inline rack rename (edit/commit)
- Device groups (TOR / Access / Other) with reorder arrows
- Intra-rack uplinks and trunks displayed as clickable link rows
- Inter-rack (external) links table
- Cable map legend
- Port-highlight SVG overlay (fixed-position line drawn between two DOM nodes)
- Calls `SwitchPanel` per device

### 5. MapPage (lines 872–1126)
Page-level orchestrator. Handles:
- Fetching topology data (`/api/topology`)
- Fetching + loading map background (`/api/map-background`)
- Fetching map display settings (`/api/map-settings`)
- `selectedRack` state + sessionStorage persistence
- `filters` state
- `rackOrders` state (localStorage-persisted device sort order)
- Toolbar (switch count / link count / Reload button)
- Coordinating `renameRack`, `moveDevice`, `updateDeviceMeta`, `reorderDevice`, `savePosition`

---

## State Variables — Ownership Map

### MapPage state
| Variable | Type | Used By |
|---|---|---|
| `topology` | `{ nodes, links, racks, classes, models }` | MapPage, TopologyMap (passed as props), RackDetail (passed as props) |
| `selectedRack` | `object \| null` | MapPage, RackDetail (passed as rack prop) |
| `filters` | `{ racks: Set\|null, classes: Set\|null }` | FilterBar, TopologyMap |
| `mapBgUrl` | `string \| null` | TopologyMap |
| `mapBgNat` | `{ w, h } \| null` | TopologyMap |
| `mapBgOpacity` | `number` | TopologyMap |
| `mapBgScale` | `number` | TopologyMap |
| `loadError` | `string \| null` | MapPage render only |
| `rackOrders` | `object` (localStorage) | MapPage `reorderDevice`, RackDetail via `deviceOrder` prop |
| `initializedRef` | `ref<boolean>` | MapPage only (prevents double sessionStorage restore) |

### TopologyMap internal state
| Variable | Used For |
|---|---|
| `drag` | Current drag target + offset |
| `positions` | Per-device map coordinates (synced from props on node change) |
| `zoom` | SVG viewport transform, persisted to `localStorage` |
| `bgPan` | Background pan origin while mouse is held |

### RackDetail internal state
| Variable | Used For |
|---|---|
| `editing` | Whether rack label input is shown |
| `nameInput` | Controlled value for rename input |
| `selectedLink` | Highlighted link object |
| `linkLine` | Computed screen-space coordinates for the SVG link-line overlay |

---

## Callbacks / Event Handlers

### TopologyMap
| Handler | Trigger |
|---|---|
| `onMouseDown(e, rack)` | Mousedown on a rack node — starts drag |
| `onBgMouseDown(e)` | Mousedown on background rect — starts pan |
| `onMouseMove(e)` | SVG-level move — updates drag or pan |
| `onMouseUp(e, rack)` | Mouseup on rack node — ends drag or fires rack select |
| wheel `handler` via `useEffect` | Zoom in/out on scroll |

### RackDetail
| Handler | Purpose |
|---|---|
| `commitRename()` | Saves renamed rack label via prop callback |
| `sortGroup(devices, groupKey)` | Sorts device list by stored order array |
| `toggleLink(l)` | Selects/deselects an intra-rack link |
| `renderGroup(devices, groupKey)` | Returns JSX for device group (reorder buttons + SwitchPanel) |
| `renderLink(l, i, accentColor)` | Returns JSX for a single link row |
| `computeLine` in `useEffect` | Computes viewport coords for cable overlay SVG |

### MapPage
| Handler | Purpose |
|---|---|
| `loadTopology()` | `useCallback` — GET `/api/topology` |
| `loadMapBg()` | `useCallback` — GET `/api/map-background` |
| `loadMapSettings()` | `useCallback` — GET `/api/map-settings` |
| `savePosition(id, x, y)` | PATCH device position |
| `renameRack(rack, newName)` | PUT rack label, reload topology |
| `moveDevice(device, newRackId)` | PATCH device rack_id, reload topology |
| `updateDeviceMeta(device, patch)` | PATCH device meta, reload topology |
| `reorderDevice(deviceId, dir, groupKey)` | Reorders device in localStorage order |

---

## Proposed Component Breakdown

The file already defines 5 components inline. The recommended change is to **extract each into its own file** and optionally extract reusable hooks. No structural redesign is needed — the boundaries are already clean.

### Extraction targets

```
frontend/src/components/map/
├── ActiveLinkBar.jsx       [extract — currently orphaned, keep for future use]
├── FilterBar.jsx           [extract]
├── TopologyMap.jsx         [extract]
├── RackDetail.jsx          [extract]
└── RackDetail/
    └── LinkOverlay.jsx     [optional further split — the fixed SVG line element]
frontend/src/hooks/
├── useTopologyData.js      [new hook]
├── useMapBackground.js     [new hook]
└── useRackOrders.js        [new hook]
```

---

### Component Descriptions

#### `ActiveLinkBar` → `components/map/ActiveLinkBar.jsx`
Pure presentational strip. Currently orphaned in the file (not rendered). Extract and wire up or remove.

**Props:**
```ts
{
  link: {
    local_ip: string,
    local_port: string,
    remote_ip: string,
    remote_port: string,
    speed_label: string
  },
  color: string,
  onClear: () => void
}
```

---

#### `FilterBar` → `components/map/FilterBar.jsx`
Stateless except for internal toggle calculations (which derive Set from props). All state lives in parent.

**Props:**
```ts
{
  racks: Array<{ id: number|string, label: string }>,
  classes: Array<{ id: number|string, label: string, color: string }>,
  filters: { racks: Set|null, classes: Set|null },
  onFilterChange: (updater: Function) => void
}
```

---

#### `TopologyMap` → `components/map/TopologyMap.jsx`
Large SVG component. Internal state: `drag`, `positions`, `zoom`, `bgPan`. Requires `useMemo`, `useRef`, `useCallback`, `useEffect` from React plus `_isValidZoom` helper (move into same file or a `mapUtils.js`).

**Props:**
```ts
{
  nodes: Array<Node>,
  links: Array<Link>,
  managedRacks: Array<Rack>,
  switchClasses: Array<SwitchClass>,
  filters: { racks: Set|null, classes: Set|null },
  onSelectRack: (rack: RackSummary) => void,
  selectedRackId: number|string|null,
  onPositionChange: (id: number, x: number, y: number) => void,
  mapBgUrl: string|null,
  mapBgOpacity: number,
  mapBgScale: number,
  mapBgNat: { w: number, h: number }|null
}
```

---

#### `RackDetail` → `components/map/RackDetail.jsx`
Complex side panel. Depends on `SwitchPanel`, `CABLE_COLORS`, `VENDOR_COLOR`, `VENDOR_ICON`, `buildPortLinkMap` from api.js.

Internal state: `editing`, `nameInput`, `selectedLink`, `linkLine`.

Heavy `useMemo` usage for link classification (uplinks, trunks, external), device grouping, port-link maps.

**Props:**
```ts
{
  rack: {
    id: number|string,
    label: string,
    location: string,
    devices: Array<Device>
  },
  allRacks: Array<{ id, label, room, description, devices }>,
  switchClasses: Array<SwitchClass>,
  switchModels: Array<SwitchModel>,
  topologyLinks: Array<Link>,
  deviceOrder: { tor?: string[], access?: string[], other?: string[] },
  onReorder: (deviceId: number, direction: "up"|"down", groupKey: string) => void,
  onClose: () => void,
  onRename: (newName: string) => void,
  onMoveDevice: (device: Device, newRackId: number|string) => void,
  onUpdateDeviceMeta: (device: Device, patch: object) => void
}
```

---

### Hook Descriptions

#### `useTopologyData()` → `hooks/useTopologyData.js`
Encapsulates:
- `topology` state
- `loadError` state
- `initializedRef`
- `selectedRack` + sessionStorage persistence
- `loadTopology` callback
- Initial load `useEffect`

Returns: `{ topology, selectedRack, setSelectedRack, loadError, loadTopology }`

---

#### `useMapBackground()` → `hooks/useMapBackground.js`
Encapsulates:
- `mapBgUrl`, `mapBgNat` state
- `mapBgOpacity`, `mapBgScale` state
- `loadMapBg()` + `loadMapSettings()` callbacks
- Initial load `useEffect`s

Returns: `{ mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale }`

---

#### `useRackOrders()` → `hooks/useRackOrders.js`
Encapsulates:
- `rackOrders` state (localStorage)
- `reorderDevice(deviceId, direction, groupKey)` function

Returns: `{ rackOrders, reorderDevice }`

---

## Duplicated Logic to Unify

`MapPage.allRacks` (lines 966–982) and `TopologyMap.racks` (useMemo lines 175–202) both independently build a rack-to-devices map and apply filters. These could be unified by computing `allRacks` once in `MapPage`/`useTopologyData` and passing it down, removing the internal re-computation in `TopologyMap`.

---

## Required Import Changes in MapPage.jsx After Split

```jsx
// Before (everything inline)
// No imports of sub-components

// After
import FilterBar from "../components/map/FilterBar.jsx";
import TopologyMap from "../components/map/TopologyMap.jsx";
import RackDetail from "../components/map/RackDetail.jsx";
import { useTopologyData } from "../hooks/useTopologyData.js";
import { useMapBackground } from "../hooks/useMapBackground.js";
import { useRackOrders } from "../hooks/useRackOrders.js";
```

The existing imports from `api.js` and `SwitchPanel` would migrate into the sub-component files that actually use them. `MapPage` would only need `api` and `API` for `savePosition`, `renameRack`, `moveDevice`, `updateDeviceMeta` — or those could move into the hooks too.

---

## Summary Table

| Component / Hook | Lines (approx) | Extract to | Complexity |
|---|---|---|---|
| `ActiveLinkBar` | 24 | `components/map/ActiveLinkBar.jsx` | Low |
| `FilterBar` | 85 | `components/map/FilterBar.jsx` | Low |
| `_isValidZoom` | 9 | `components/map/TopologyMap.jsx` or `mapUtils.js` | Low |
| `TopologyMap` | 295 | `components/map/TopologyMap.jsx` | Medium |
| `RackDetail` | 450 | `components/map/RackDetail.jsx` | High |
| `useTopologyData` | ~60 | `hooks/useTopologyData.js` | Medium |
| `useMapBackground` | ~35 | `hooks/useMapBackground.js` | Low |
| `useRackOrders` | ~30 | `hooks/useRackOrders.js` | Low |
| `MapPage` (residual) | ~100 | `pages/MapPage.jsx` | Low |

After the split, `MapPage.jsx` would be reduced from **1126 lines to approximately 100 lines** — a pure orchestrator.
