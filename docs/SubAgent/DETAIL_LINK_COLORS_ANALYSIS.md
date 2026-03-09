# Detail Panel Link Colors & Partner IP - Analysis

## 1. Current State of SwitchDetailSlideIn

**File:** `frontend/src/components/SwitchDetailSlideIn.jsx`

- Receives only `{ deviceId, nodes, onClose }` as props
- Finds the device from `nodes` by ID, renders a port table with columns: PORT #, NAME, STATUS, SPEED, NATIVE VLAN, TAGGED VLANS, MAC ADDRESS, IP, HOSTNAME
- Panel width: `width: "75vw"`, `maxWidth: 1200`
- No awareness of topology links, port link maps, or link colors
- The IP column currently shows `port.peer_ip` (the endpoint device IP learned from ARP/SNMP), NOT the link partner switch IP

**Rendered in:** `frontend/src/pages/MapPage.jsx` (lines 265-269):
```jsx
<SwitchDetailSlideIn
  deviceId={detailSwitchId}
  nodes={topology.nodes}
  onClose={() => setDetailSwitchId(null)}
/>
```

## 2. How Link Colors Work in the Rack View

### Data Flow

1. **Topology links** (`topology.links`) come from the backend as `TopologyLinkOut`:
   - `local_ip`, `local_port`, `remote_ip`, `remote_port`, `remote_sys`, `speed_label`

2. **RackDetail** (`frontend/src/components/map/RackDetail.jsx`) receives `topologyLinks` and builds:

   a. **`portLinkMap`** via `buildPortLinkMap(allVisibleLinks)`:
      - Keys: `"<ip>:<normalizedPort>"` (e.g., `"10.0.0.1:1/1/1"`)
      - Values: `{ link: <linkObject>, role: "from" | "to" }`
      - This maps every port that participates in a topology link to its link data

   b. **`linkColorMap`** - a per-port-key color map:
      - Keys: same `"<ip>:<normalizedPort>"` format
      - Values: CSS color string from `CABLE_COLORS` array or `rackPairColorMap`
      - Built by iterating `allVisibleLinks`, assigning one color per unique switch pair (`[local_ip, remote_ip].sort().join("|")`)
      - Prefers rack-pair colors from `rackPairColorMap` (shared with SVG topology lines) for consistency

3. **SwitchPanel** receives `portLinkMap`, `linkColorMap`, `selectedLink`, `onPortClick`, `interRackPortKeys` and passes them to each **Port** component:
   - Port key format: `"<device.ip>:<normPort(port.if_descr)>"`
   - Each Port gets: `cableColor={linkColorMap?.[pKey]}`

4. **Port** component uses the color for:
   - Background tint (`${cc}12` or `${cc}28`)
   - Border color
   - Glow/shadow
   - A small colored dot indicator in the corner

### Color Assignment
```
CABLE_COLORS = ["#f472b6","#fb923c","#a78bfa","#34d399","#fbbf24","#60a5fa","#f87171","#e879f9"]
```
Colors are assigned per switch pair. If a rack-pair color exists in `rackPairColorMap`, that takes priority for visual consistency with SVG topology lines.

## 3. How to Get Link Partner IP

The topology link object contains:
- `local_ip` / `local_port` - this side of the link
- `remote_ip` / `remote_port` - the other side of the link

For a given device + port in the detail panel:
1. Build a port key: `"<device.ip>:<normPort(port.if_descr)>"`
2. Look up in `portLinkMap[portKey]`
3. If found, the link entry has `{ link, role }`:
   - If `role === "from"`: partner IP = `link.remote_ip`
   - If `role === "to"`: partner IP = `link.local_ip`

This gives the switch-to-switch link partner IP (the connected switch IP), which is different from `port.peer_ip` (the ARP-learned endpoint IP).

## 4. What Props Need to Be Threaded to SwitchDetailSlideIn

### Currently available in MapPage
- `topology.links` - all topology links
- `topology.nodes` - all devices (already passed as `nodes`)
- `rackPairColorMap` - rack-pair color assignments
- `CABLE_COLORS` - color palette (imported from api.js)

### Option A: Build portLinkMap/linkColorMap inside SwitchDetailSlideIn

Pass `topologyLinks` and `rackPairColorMap` to the component and let it compute `portLinkMap` and `linkColorMap` internally using the same `buildPortLinkMap` and color assignment logic. This keeps MapPage simple.

**New props needed:**
- `topologyLinks` (= `topology.links`)
- `rackPairColorMap` (already computed in MapPage)
- `allRacks` (needed by linkColorMap to build `ipToRackId` mapping for rack-pair color lookup)

### Option B: Pre-compute and pass portLinkMap/linkColorMap

Compute them in MapPage and pass them. However, RackDetail already computes these scoped to a single rack. For the detail panel, we need ALL links for the specific device, so we'd filter topology.links to only those involving the device IP and then build the maps.

### Recommended: Option A

Build inside the component. The component already knows the device IP (from `deviceId` lookup in `nodes`). Steps:
1. Filter `topologyLinks` to links involving `device.ip`
2. Call `buildPortLinkMap()` on those links
3. Build `linkColorMap` using the same per-pair color logic (with `rackPairColorMap` for consistency)

## 5. Implementation Summary

### Width Change
- Change `width: "75vw"` to `width: "80vw"` and `maxWidth: 1200` to `maxWidth: 1400` (or similar)

### Port Row Coloring in Detail Table
For each port row in the table:
1. Build `portKey = \`${device.ip}:${normPort(port.if_descr)}\``
2. Look up `portLinkMap[portKey]` - if present, the port has a topology link
3. Look up `linkColorMap[portKey]` - the color to use
4. Apply a subtle tinted left border or row background to the `<tr>` using the link color

### Link Partner IP in IP Column
Currently the IP column shows `port.peer_ip`. For linked ports, show the link partner IP instead (or in addition):
1. From `portLinkMap[portKey]`, determine partner IP
2. Display it in the IP column (possibly in the link color to distinguish it from the regular peer_ip)

### Props to Add in MapPage
```jsx
<SwitchDetailSlideIn
  deviceId={detailSwitchId}
  nodes={topology.nodes}
  topologyLinks={topology.links}       // NEW
  rackPairColorMap={rackPairColorMap}   // NEW
  allRacks={allRacks}                   // NEW (for ipToRackId in color mapping)
  onClose={() => setDetailSwitchId(null)}
/>
```

### Key Imports Needed in SwitchDetailSlideIn
- `buildPortLinkMap`, `normPort`, `CABLE_COLORS` from `../api.js`
