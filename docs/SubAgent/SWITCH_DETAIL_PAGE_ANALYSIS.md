# Switch Detail Page - Research & Analysis

## 1. Current App Architecture

### Routing
- **React Router v6** (`react-router-dom ^6.28.0`) with `BrowserRouter`
- Routes defined in `frontend/src/main.jsx` (lines 13-25)
- Layout component: `App.jsx` wraps all authenticated pages via `<Outlet />`
- Current routes:
  - `/login` - standalone (no App wrapper)
  - `/` - `DashboardPage`
  - `/map` - `MapPage`
  - `/logs` - `LogsPage`
  - `/settings` - `SettingsPage`
- No dynamic routes (e.g. `/switch/:id`) exist yet

### State Management
- **Zustand** (`^4.5.0`) store in `frontend/src/store.js`
- Store slices: topology (nodes/links/racks/classes), map background, scan, rack orders
- `loadTopology()` fetches `/api/topology` which returns **all devices with all ports embedded**
- `selectedRack` state tracks which rack panel is open on the map page

### Build Setup
- **Vite** with React plugin, dev proxy for `/api/*` to `http://localhost:8000`
- No hash routing or special SPA config beyond standard Vite

### Page Structure
- `App.jsx` provides header nav bar (48px) + `<Outlet />` for page content
- Nav tabs: Dashboard, Topology, Logs, Settings
- Each page is a standalone component in `frontend/src/pages/`

---

## 2. How Racks & Switches Are Rendered

### Rack Overview (Dashboard)
- `DashboardPage.jsx` (lines 173-215) renders a "Racks Overview" table
- Columns: RACK, ROOM, SWITCHES, PORTS, ACTIVE
- Each row shows `r.label`, `r.room`, `r.deviceCount`, `r.totalPorts`, `r.activePorts`
- **No per-switch details or "Details" button exists on the dashboard rack table**
- Clicking a rack row does nothing currently (no onClick handler)

### Rack Detail (Map Page)
- `MapPage.jsx` renders a split layout: topology map (left) + rack detail panel (right)
- Clicking a rack on the map opens `RackDetail.jsx` in a side panel
- `RackDetail.jsx` (`frontend/src/components/map/RackDetail.jsx`):
  - Shows rack header with name, location, port counts
  - Groups devices by switch class into sections
  - Each device rendered via `SwitchPanel.jsx`
  - Sections: device panels, Uplinks, TOR Trunks, Inter-Rack links, Cable Map

### SwitchPanel Component
- `frontend/src/components/SwitchPanel.jsx` renders a single switch:
  - Header: ping status dot, model/sys_name, class badge, IP, port count, ping info
  - Collapsible port grid (visual port layout in 2 rows: odd/even by if_index)
  - "Change rack" button for moving device between racks
  - Props: `device`, `otherRacks`, `onMove`, `portLinkMap`, `selectedLink`, `onPortClick`, `switchClass`, `switchModel`, etc.
  - **No "Details" button currently exists on SwitchPanel**

### Port Component
- `frontend/src/components/Port.jsx` renders individual port squares (34x20px)
- Hover shows tooltip with: endpoint count, IP, hostname, MAC, port name, speed, VLAN, tagged VLANs, endpoint list
- Double-click opens `PortDetailModal`
- Click selects/deselects a cable link

### PortDetailModal
- `frontend/src/components/PortDetailModal.jsx` - modal overlay for a single port
- Shows: port name, status (Up/Down), speed, VLAN, tagged VLANs, endpoint count
- Table of endpoints: MAC, IP, HOSTNAME with search filter
- **Only shows data for one port at a time**

---

## 3. Available Port Data from the API

### Backend Port Model (`backend/database.py`, line 179)
Port table columns:
| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `device_id` | Integer | FK to devices |
| `if_index` | Integer | SNMP interface index |
| `if_descr` | String | Interface description (e.g. "1/1/1") |
| `if_alias` | String | Interface alias |
| `speed_mbps` | Integer | Speed in Mbps |
| `oper_status` | Integer | 1=up, 2=down |
| `peer_mac` | String | Connected device MAC |
| `peer_ip` | String | Connected device IP |
| `peer_host` | String | Connected device hostname |
| `endpoint_count` | Integer | Number of endpoints on port |
| `endpoint_details_json` | JSONB | Array of {mac, ip, host} objects |
| `vlan` | Integer | Native/untagged VLAN |
| `tagged_vlans` | JSONB | Array of tagged VLAN IDs |

### PortOut Schema (`backend/schemas.py`, lines 290-317)
All columns are exposed via the `PortOut` Pydantic model. Null values are coerced to safe defaults (0, "", []).

### Topology API Response
- `GET /api/topology` returns `TopologyOut` with `nodes: List[DeviceOut]`
- `DeviceOut` includes `ports: List[PortOut]` (all ports embedded per device)
- **All port data is already available on the frontend** via `topology.nodes[].ports[]`
- No separate per-device API endpoint needed (data is already loaded)

### DeviceOut Schema (relevant fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Device ID |
| `sys_name` | str | System name |
| `ip` | str | Device IP |
| `model` | str | Model string |
| `vendor` | str | Vendor identifier |
| `ports` | List[PortOut] | All ports |
| `rack_id` | int/null | Rack assignment |
| `class_id` | int/null | Switch class |
| `model_id` | int/null | Switch model FK |
| `ping_status` | str | "online"/"offline"/"unknown" |
| `ping_rtt_ms` | int | Ping RTT |

---

## 4. Navigation Approach Options

### Option A: React Router URL Route (Recommended)
- Add route `/switch/:id` in `main.jsx`
- New page `SwitchDetailPage.jsx` in `frontend/src/pages/`
- Navigate via `useNavigate()` from rack overview or SwitchPanel
- **Pros**: Shareable URLs, browser back/forward, clean separation
- **Cons**: Needs topology data loading on the new page (already solved by Zustand store)
- The global topology is already cached in Zustand, so the detail page can read `topology.nodes.find(n => n.id === id)` directly

### Option B: Modal/Overlay
- Render a full-screen modal over the current page
- **Pros**: No routing changes, context preserved
- **Cons**: No shareable URL, modal-on-modal complexity

### Option C: View State Toggle (like RackDetail panel)
- Toggle between rack view and switch detail view in the side panel
- **Pros**: Familiar pattern in the app
- **Cons**: Only works from map page, not from dashboard

**Recommendation: Option A (URL route)** - most versatile, allows access from both dashboard and map page, provides bookmarkable URLs.

---

## 5. "Details" Button Placement

### Primary Location: SwitchPanel Header
- `SwitchPanel.jsx` header bar (the clickable area at lines 18-49)
- Currently has: ping dot, model name, class badge, IP/port info, rack-move button, collapse chevron
- Add a "Details" button next to the "Change rack" (`<>`) button
- Should use `useNavigate()` to go to `/switch/${device.id}`
- Needs `e.stopPropagation()` to prevent toggling the collapse

### Secondary Location: Dashboard Rack Table
- The rack overview table in `DashboardPage.jsx` (lines 173-215) only shows rack-level stats
- To add per-switch navigation from the dashboard, we could:
  1. Make each rack row expandable to show switches
  2. Or add a separate "Switches" table/section on the dashboard
- **Simplest approach for now**: Only add the button in `SwitchPanel` (accessible from Map page)
- Future: Could add a switch list section to the dashboard

### From RackDetail Context
- `RackDetail.jsx` renders `SwitchPanel` via `renderGroup()` (line 211)
- Each `SwitchPanel` already receives the full `device` object
- The "Details" button in `SwitchPanel` will naturally appear in `RackDetail`

---

## 6. Data Flow for the Detail Page

### No New API Endpoint Needed
The topology data already contains all port information. The flow:
1. User clicks "Details" on a SwitchPanel
2. Navigation to `/switch/:id`
3. `SwitchDetailPage` reads `id` from `useParams()`
4. Fetches device from Zustand store: `topology.nodes.find(n => n.id === Number(id))`
5. If store is empty (direct URL access), calls `loadTopology()` first
6. Renders port table from `device.ports`

### Port Table Columns (as requested)
| Column | Source Field | Notes |
|--------|-------------|-------|
| Number | `port.if_index` | Sort by this |
| Port Name | `port.if_descr` | Interface description |
| Status | `port.oper_status` | 1 = Online (green), 2 = Offline (red) |
| Speed | `port.speed_mbps` | Use `speedLabel()` helper |
| Native VLAN | `port.vlan` | 0 = none |
| Tagged VLANs | `port.tagged_vlans` | Array, join with ", " |
| MAC Address | `port.peer_mac` | Connected device MAC |
| IP | `port.peer_ip` | Connected device IP |
| Hostname | `port.peer_host` | Connected device hostname |
| Endpoints | `port.endpoint_count` | Count of connected hosts |

---

## 7. Relevant File Paths

### Files to Create
| File | Purpose |
|------|---------|
| `frontend/src/pages/SwitchDetailPage.jsx` | New page component with port table |

### Files to Modify
| File | Change | Lines |
|------|--------|-------|
| `frontend/src/main.jsx` | Add `/switch/:id` route | 20-22 (after map route) |
| `frontend/src/components/SwitchPanel.jsx` | Add "Details" button in header | 33-48 (button area) |

### Files for Reference (no changes needed)
| File | Purpose |
|------|---------|
| `frontend/src/store.js` | Zustand store - topology already cached |
| `frontend/src/api.js` | API helpers, `speedLabel()`, `speedColor()` |
| `frontend/src/components/PortDetailModal.jsx` | Style reference for port details |
| `frontend/src/components/Port.jsx` | Port data parsing reference |
| `frontend/src/App.jsx` | Layout wrapper for all pages |
| `backend/schemas.py` | PortOut schema (lines 290-317) |
| `backend/routers/topology.py` | Topology API (no changes needed) |

---

## 8. Design Considerations

### Styling
- App uses inline styles throughout (no CSS framework)
- Dark theme: `#020817` (bg), `#0f172a` (card), `#1e293b` (border)
- Font: Inter, system-ui, sans-serif
- Accent colors: `#22d3ee` (cyan), `#4ade80` (green), `#f87171` (red)
- Table style reference: Dashboard rack table and PortDetailModal endpoint table

### Navigation Header
- The SwitchDetailPage should show a breadcrumb or back button (e.g., "< Back to Map")
- Device summary info: name, IP, model, vendor, ping status, class

### Port Table Features
- Sort by if_index (default), clickable column headers for sorting
- Optional: filter/search box (like PortDetailModal)
- Status column: green dot for online (oper_status=1), red for offline
- Tagged VLANs: comma-separated list, or "none"
- Empty cells: show "-" for missing data (consistent with PortDetailModal)

### Responsive Width
- Dashboard uses `maxWidth: 1100` centered layout
- Port table should fit within this or use horizontal scroll for many columns
