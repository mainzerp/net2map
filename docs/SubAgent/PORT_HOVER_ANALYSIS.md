# Port Hover Tooltip Analysis

## 1. Available Data Fields (API / Backend)

### Database Model (`backend/database.py` - Port class, line 178)

| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `device_id` | Integer | FK to devices |
| `if_index` | Integer | Interface index number |
| `if_descr` | String | Interface description (e.g. "GigabitEthernet0/1") |
| `if_alias` | String | Interface alias |
| `speed_mbps` | Integer | Speed in Mbps |
| `oper_status` | Integer | 1=up, 2=down |
| `peer_mac` | String | Connected device MAC address |
| `peer_ip` | String | Connected device IP address |
| `peer_host` | String | Connected device hostname (DNS) |
| `endpoint_count` | Integer | Number of endpoints on this port |
| `endpoint_details_json` | JSONB | Array of endpoint objects `[{mac, ip, host}, ...]` |
| `vlan` | Integer | VLAN ID |

### Schema (`backend/schemas.py` - PortOut, line 286)

All fields above are exposed via `PortOut` and included in `DeviceOut.ports`. The topology API (`GET /api/topology`) returns full `DeviceOut` objects which include the complete `ports` list with all peer/endpoint fields.

### Endpoint Detail JSON Structure

Each entry in `endpoint_details_json` is an object with:
- `mac` - MAC address
- `ip` - IP address
- `host` - DNS hostname

## 2. Current Port Rendering Architecture

### Component Hierarchy

```
TopologyMap (SVG overview - no individual ports rendered)
  |
  +-> RackDetail (opened on rack click)
        |
        +-> SwitchPanel (one per device in rack)
              |
              +-> Port (one per physical port)
                    |
                    +-> PortDetailModal (on double-click, if endpoints exist)
```

### Port Component (`frontend/src/components/Port.jsx`)

**Props received:**
- `port` - Full port object with all fields (peer_mac, peer_ip, peer_host, endpoint_details_json, etc.)
- `portKey` - String key like `"192.168.1.1:GigabitEthernet0/1"`
- `portLinkMap` - Map of portKey -> link data (for switch-to-switch links)
- `selectedLink` - Currently selected link (for highlight state)
- `onPortClick` - Click handler for link selection
- `cableColor` - Color for linked ports
- `interRack` - Boolean, whether this port connects to another rack

**Visual representation:**
- Small 34x20px colored rectangle showing `if_index` number
- Color indicates speed (green=1G, cyan=10G+, amber=<1G, dark=inactive)
- Link indicator dot in top-right corner for linked ports
- Native `title={port.if_descr}` attribute on the inner div (browser tooltip with port description)

### SwitchPanel Component (`frontend/src/components/SwitchPanel.jsx`)

- Receives `device` (with full `device.ports` array)
- Sorts ports by `if_index`, splits into odd/even rows (top/bottom physical layout)
- Constructs `portKey` as `${device.ip}:${normPort(port.if_descr)}`
- Passes all link-related props down to each Port component

### RackDetail Component (`frontend/src/components/map/RackDetail.jsx`)

- Builds `portLinkMap`, `linkColorMap`, `interRackPortKeys` from topology links
- Passes these down through SwitchPanel to Port components

### TopologyMap Component (`frontend/src/components/map/TopologyMap.jsx`)

- SVG-based rack overview - does NOT render individual Port components
- Shows rack summaries with port counts (e.g. "12/48 ports active")
- No port-level hover behavior here

## 3. Existing Tooltip / Hover System

### ALREADY FULLY IMPLEMENTED

The Port component already has a comprehensive custom tooltip system. The hover tooltip currently shows:

**For linked ports (switch-to-switch):**
- "Switch-to-switch" label with speed
- Local/remote IP and port names
- Click instruction

**For ports with endpoints (hasDev=true):**
- Endpoint count ("Hosts: N")
- `peer_ip` (shown as "IP")
- `peer_host` (shown as "Host")
- `peer_mac` (shown as "MAC")
- Port description (`if_descr`)
- Speed with color
- VLAN (if > 0)
- When multiple endpoints: scrollable list showing `host || ip || mac` for each endpoint

**Trigger conditions:**
- `onMouseEnter` fires only if `hasDev || isLinked` (port has endpoints or switch-to-switch link)
- `onMouseLeave` hides tooltip
- Tooltip is positioned via `position:fixed` with smart viewport-edge detection (flips above if overflowing bottom, clamps horizontal)
- Tooltip has `pointerEvents:"none"` (doesn't interfere with mouse)

**Double-click behavior:**
- Opens `PortDetailModal` if `hasDev` is true
- Modal shows a filterable table of all endpoints with MAC, IP, and hostname columns

### Endpoint Detection Logic

```js
const endpointCount = Math.max(
  Number(port.endpoint_count || 0),
  parsedEndpoints.length,
  (port.peer_ip || port.peer_mac) ? 1 : 0,
);
const hasDev = endpointCount > 0;
```

This means the tooltip will show even if only `peer_ip` or `peer_mac` is populated (no parsed endpoints needed).

## 4. What the User Wants vs. What Already Exists

### Current State: The tooltip ALREADY shows MAC, IP, and hostname

The existing hover tooltip in `Port.jsx` (lines 104-140) already displays:
- `port.peer_ip` as "IP" (cyan color)
- `port.peer_host` as "Host" (white color)
- `port.peer_mac` as "MAC" (default color)
- Multiple endpoints list with host/ip/mac when `parsedEndpoints.length > 1`

### Potential Issues / Gaps

1. **Tooltip only shows for active ports with endpoints or links.** Ports that are `oper_status === 1` but have no `peer_ip`, `peer_mac`, or `endpoint_count` will NOT show a tooltip on hover (the `onMouseEnter` guard: `if (!hasDev && !isLinked) return;`).

2. **Single-endpoint display:** When there is exactly 1 endpoint in `parsedEndpoints`, only `peer_ip`/`peer_host`/`peer_mac` are shown in the grid. The endpoint list section only appears when `parsedEndpoints.length > 1`. If peer fields are empty but `endpoint_details_json` has one entry, the individual endpoint's mac/ip/host won't show in the grid display.

3. **No tooltip for inactive ports:** Ports with `oper_status !== 1` that happen to have stale endpoint data still show tooltips (since `hasDev` checks endpoint count, not oper_status).

4. **All data flows correctly:** The full port object with all fields is already passed from API -> topology store -> RackDetail -> SwitchPanel -> Port. No additional API changes needed.

## 5. Summary

| Aspect | Status |
|--------|--------|
| Backend has MAC/IP/hostname fields | YES - `peer_mac`, `peer_ip`, `peer_host`, `endpoint_details_json` |
| API returns these fields | YES - `PortOut` schema includes all fields |
| Data flows to Port component | YES - full `port` object passed as prop |
| Hover tooltip exists | YES - custom tooltip with viewport-aware positioning |
| Tooltip shows MAC/IP/hostname | YES - already displays `peer_ip`, `peer_host`, `peer_mac` |
| Multi-endpoint list shows | YES - when `parsedEndpoints.length > 1` |
| Double-click detail modal | YES - `PortDetailModal` with filterable endpoint table |

### If Enhancement Is Still Needed

Possible improvements could include:
- **Always show single endpoint details from `endpoint_details_json`** even when `parsedEndpoints.length === 1` (currently only shows peer_* fields in that case)
- **Show tooltip for all active ports** regardless of endpoint data (remove `hasDev || isLinked` guard)
- **Show all endpoint details inline** rather than just host/ip summary in the multi-endpoint list
- **Styling/UX improvements** to the existing tooltip (larger, more prominent MAC/IP/hostname display)
