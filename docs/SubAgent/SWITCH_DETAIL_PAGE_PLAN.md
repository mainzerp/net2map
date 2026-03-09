# Switch Detail Page - Implementation Plan

## Goal
Add a per-switch detail page at `/switch/:id` with a sortable port table, accessible via a "Details" button on each switch in the rack overview.

---

## Checklist

- [ ] Step 1: Create `SwitchDetailPage.jsx`
- [ ] Step 2: Add route in `main.jsx`
- [ ] Step 3: Add "Details" button in `SwitchPanel.jsx`

---

## Step 1: Create `frontend/src/pages/SwitchDetailPage.jsx`

Create a new file at `frontend/src/pages/SwitchDetailPage.jsx`.

### 1.1 Imports and Setup

```jsx
import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { speedLabel } from "../api.js";
import useNetmapStore from "../store.js";
```

- `useParams` to read `:id` from the URL
- `useNavigate` for the back button
- `speedLabel` from `api.js` (line 93) to format port speeds
- Zustand store to access `topology.nodes` and `loadTopology`

### 1.2 Data Loading Logic

```jsx
export default function SwitchDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const topology = useNetmapStore(s => s.topology);
  const loadTopology = useNetmapStore(s => s.loadTopology);
  const [sortCol, setSortCol] = useState("if_index");
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    if (!topology.nodes.length) loadTopology();
  }, [topology.nodes.length, loadTopology]);

  const device = useMemo(
    () => topology.nodes.find(n => n.id === Number(id)),
    [topology.nodes, id]
  );
```

- If user navigates directly to `/switch/5`, the store may be empty. The `useEffect` calls `loadTopology()` to populate it.
- `device` is derived from store via `topology.nodes.find(n => n.id === Number(id))`.

### 1.3 Sorting Logic

Define column sort configuration and a memoized sorted port list:

```jsx
  const columns = [
    { key: "if_index",      label: "PORT #",        align: "right" },
    { key: "if_descr",      label: "NAME",          align: "left" },
    { key: "oper_status",   label: "STATUS",        align: "center" },
    { key: "speed_mbps",    label: "SPEED",         align: "right" },
    { key: "vlan",          label: "NATIVE VLAN",   align: "right" },
    { key: "tagged_vlans",  label: "TAGGED VLANS",  align: "left" },
    { key: "peer_mac",      label: "MAC ADDRESS",   align: "left" },
    { key: "peer_ip",       label: "IP",            align: "left" },
    { key: "peer_host",     label: "HOSTNAME",      align: "left" },
  ];

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const sortedPorts = useMemo(() => {
    if (!device) return [];
    const list = [...device.ports];
    list.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      // tagged_vlans: sort by length
      if (sortCol === "tagged_vlans") {
        va = (va || []).length;
        vb = (vb || []).length;
      }
      // string comparison for text fields
      if (typeof va === "string" && typeof vb === "string")
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      // fallback numeric
      va = va ?? 0;
      vb = vb ?? 0;
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [device, sortCol, sortAsc]);
```

### 1.4 Loading and Not-Found States

```jsx
  if (!topology.nodes.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
        height: "calc(100vh - 48px)", color: "#475569", fontSize: 12 }}>
        Loading...
      </div>
    );
  }

  if (!device) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", height: "calc(100vh - 48px)", gap: 12 }}>
        <div style={{ color: "#f87171", fontSize: 13 }}>Switch not found</div>
        <button onClick={() => navigate(-1)} style={{
          border: "1px solid #1e293b", background: "none", color: "#94a3b8",
          borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 11,
          fontFamily: "'Inter', system-ui, sans-serif",
        }}>Go Back</button>
      </div>
    );
  }
```

Match the loading/error patterns from `DashboardPage.jsx` (lines 131-143).

### 1.5 Page Layout and Switch Header

Use the same container width and style tokens as `DashboardPage.jsx`:

```jsx
  const pingStatus = device.ping_status || "unknown";
  const statusColor = pingStatus === "online" ? "#22c55e"
    : pingStatus === "offline" ? "#f87171" : "#64748b";
  const activePorts = device.ports.filter(p => p.oper_status === 1);

  return (
    <div style={{
      padding: "32px 40px", maxWidth: 1100, margin: "0 auto",
      fontFamily: "'Inter', system-ui, sans-serif",
      height: "calc(100vh - 48px)", overflowY: "auto",
    }}>
      {/* Back button */}
      <button onClick={() => navigate(-1)} style={{
        border: "none", background: "none", color: "#475569",
        cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 16,
        fontFamily: "'Inter', system-ui, sans-serif",
        display: "flex", alignItems: "center", gap: 4,
      }}>
        <span style={{ fontSize: 14 }}>&larr;</span> Back
      </button>

      {/* Switch header card */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b",
        borderRadius: 10, padding: "20px 24px", marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div title={pingStatus} style={{
            width: 10, height: 10, borderRadius: "50%",
            backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}`,
          }} />
          <span style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>
            {device.sys_name || device.ip}
          </span>
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "#94a3b8" }}>
          <span><span style={{ color: "#475569" }}>IP:</span> {device.ip}</span>
          {device.vendor && <span><span style={{ color: "#475569" }}>Vendor:</span> {device.vendor}</span>}
          {device.model && <span><span style={{ color: "#475569" }}>Model:</span> {device.model}</span>}
          {device.location && <span><span style={{ color: "#475569" }}>Location:</span> {device.location}</span>}
          <span><span style={{ color: "#475569" }}>Ports:</span> {activePorts.length}/{device.ports.length} active</span>
          {device.ping_rtt_ms != null && pingStatus === "online" && (
            <span><span style={{ color: "#475569" }}>RTT:</span> {device.ping_rtt_ms}ms</span>
          )}
        </div>
      </div>
```

Style tokens used:
- Background `#0a0e18` (card), `#1e293b` (border) -- same as `DashboardPage` `cardStyle` (line 104)
- Ping status dot pattern from `SwitchPanel.jsx` (lines 28-31)

### 1.6 Port Table

```jsx
      {/* Port table */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b",
        borderRadius: 10, padding: "20px 24px",
      }}>
        <div style={{
          fontSize: 10, color: "#475569", letterSpacing: "0.08em",
          textTransform: "uppercase", marginBottom: 14,
        }}>
          Ports ({device.ports.length})
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1e293b" }}>
                {columns.map(col => (
                  <th key={col.key}
                    onClick={() => handleSort(col.key)}
                    style={{
                      padding: "8px 10px", color: sortCol === col.key ? "#e2e8f0" : "#475569",
                      fontWeight: 600, fontSize: 9, letterSpacing: 1,
                      textAlign: col.align, cursor: "pointer", userSelect: "none",
                      whiteSpace: "nowrap",
                    }}>
                    {col.label}{sortCol === col.key ? (sortAsc ? " ^" : " v") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedPorts.map(port => (
                <tr key={port.id} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "8px 10px", color: "#94a3b8", textAlign: "right" }}>
                    {port.if_index}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#e2e8f0", fontWeight: 500 }}>
                    {port.if_descr || "-"}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center" }}>
                    <span style={{
                      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                      backgroundColor: port.oper_status === 1 ? "#22c55e" : "#334155",
                      boxShadow: port.oper_status === 1 ? "0 0 4px #22c55e" : "none",
                    }} />
                  </td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8", textAlign: "right" }}>
                    {port.speed_mbps ? speedLabel(port.speed_mbps) : "-"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#7dd3fc", textAlign: "right" }}>
                    {port.vlan || "-"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8" }}>
                    {port.tagged_vlans && port.tagged_vlans.length > 0
                      ? port.tagged_vlans.join(", ")
                      : "-"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
                    {port.peer_mac || "-"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
                    {port.peer_ip || "-"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8" }}>
                    {port.peer_host || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

Table styling matches the rack overview table in `DashboardPage.jsx` (lines 308-330):
- `th`: padding `8px 10px`, color `#475569`, fontSize 9, letterSpacing 1, uppercase
- `td`: padding `8px 10px`, border-bottom `1px solid #0f172a`
- Status column: green dot for `oper_status === 1`, dark for down (same pattern as `SwitchPanel.jsx` line 29)
- MAC/IP columns: monospace font for readability
- Tagged VLANs: `join(", ")` or "-" when empty
- Horizontal scroll via `overflowX: "auto"` for narrow viewports

---

## Step 2: Update `frontend/src/main.jsx` - Add Route

**File:** `frontend/src/main.jsx`

### 2.1 Add Import (after line 8)

Add the `SwitchDetailPage` import between the existing page imports (after `SettingsPage`, before `LoginPage`):

```jsx
import SwitchDetailPage from "./pages/SwitchDetailPage.jsx";
```

Current imports (lines 5-9):
```jsx
import DashboardPage from "./pages/DashboardPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import LogsPage from "./pages/LogsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
```

After change (lines 5-10):
```jsx
import DashboardPage from "./pages/DashboardPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import LogsPage from "./pages/LogsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import SwitchDetailPage from "./pages/SwitchDetailPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
```

### 2.2 Add Route (after line 21)

Add the `/switch/:id` route inside the `<Route element={<App />}>` group, after the settings route (line 21):

Current (lines 18-23):
```jsx
        <Route element={<App />}>
          <Route index element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="map" element={<ErrorBoundary><MapPage /></ErrorBoundary>} />
          <Route path="logs" element={<ErrorBoundary><LogsPage /></ErrorBoundary>} />
          <Route path="settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
        </Route>
```

After change:
```jsx
        <Route element={<App />}>
          <Route index element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="map" element={<ErrorBoundary><MapPage /></ErrorBoundary>} />
          <Route path="logs" element={<ErrorBoundary><LogsPage /></ErrorBoundary>} />
          <Route path="settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
          <Route path="switch/:id" element={<ErrorBoundary><SwitchDetailPage /></ErrorBoundary>} />
        </Route>
```

This places the route inside the `<App />` layout wrapper so the header nav bar renders on the detail page. The `ErrorBoundary` wrapper matches all other routes.

---

## Step 3: Update `frontend/src/components/SwitchPanel.jsx` - Add Details Button

**File:** `frontend/src/components/SwitchPanel.jsx`

### 3.1 Add `useNavigate` Import (line 1)

Current line 1:
```jsx
import { useEffect, useRef, useState } from "react";
```

After change:
```jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
```

### 3.2 Add `useNavigate` Hook (inside component, after line 9)

Current lines 8-10:
```jsx
  const [open, setOpen] = useState(true);
  const [showMove, setShowMove] = useState(false);
  const panelRef = useRef(null);
```

After change:
```jsx
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [showMove, setShowMove] = useState(false);
  const panelRef = useRef(null);
```

### 3.3 Add "Details" Button in Header (lines 56-67)

Add a "Details" button in the right-side button group, before the "Change rack" button. This button group is at lines 56-67 inside the header `<div>`.

Current button area (lines 56-67):
```jsx
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {onMove && otherRacks.length > 0 && (
            <div
              title="Change rack"
              onClick={e => { e.stopPropagation(); setShowMove(v => !v); }}
              style={{
                fontSize:11, color: showMove ? "#22d3ee" : "#475569",
                padding:"2px 5px", borderRadius:4,
                border:`1px solid ${showMove ? "#164e63" : "#1e293b"}`,
                backgroundColor: showMove ? "#083344" : "transparent",
                cursor:"pointer", userSelect:"none",
              }}
            >{"<>"}</div>
          )}
          <span style={{color:"#475569",fontSize:16}}>{open ? "v" : ">"}</span>
        </div>
```

After change:
```jsx
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div
            title="Switch details"
            onClick={e => { e.stopPropagation(); navigate(`/switch/${device.id}`); }}
            style={{
              fontSize:11, color:"#475569",
              padding:"2px 5px", borderRadius:4,
              border:"1px solid #1e293b",
              backgroundColor:"transparent",
              cursor:"pointer", userSelect:"none",
            }}
          >[i]</div>
          {onMove && otherRacks.length > 0 && (
            <div
              title="Change rack"
              onClick={e => { e.stopPropagation(); setShowMove(v => !v); }}
              style={{
                fontSize:11, color: showMove ? "#22d3ee" : "#475569",
                padding:"2px 5px", borderRadius:4,
                border:`1px solid ${showMove ? "#164e63" : "#1e293b"}`,
                backgroundColor: showMove ? "#083344" : "transparent",
                cursor:"pointer", userSelect:"none",
              }}
            >{"<>"}</div>
          )}
          <span style={{color:"#475569",fontSize:16}}>{open ? "v" : ">"}</span>
        </div>
```

Key points:
- `e.stopPropagation()` prevents the click from toggling the panel collapse (same pattern as the "Change rack" button on line 60)
- Button styled consistently with "Change rack": same fontSize, padding, borderRadius, border color
- Uses `[i]` text label (matching the `[<>]` pattern of the rack-move button)
- Always visible (not gated by `onMove` since details are always available)

---

## Design Notes

### Style Tokens (reference)
| Token | Value | Usage |
|-------|-------|-------|
| Page background | `#020817` | Body/html background (set in `App.jsx` global styles) |
| Card background | `#0a0e18` | Dashboard cards, detail page cards |
| Panel background | `#0f172a` | SwitchPanel, inner sections |
| Border | `#1e293b` | Card/table borders |
| Row border | `#0f172a` | Table row separators |
| Text primary | `#e2e8f0` | Headings, device names |
| Text secondary | `#94a3b8` | Data values |
| Text muted | `#475569` | Labels, column headers |
| Accent cyan | `#22d3ee` | Active states, links |
| Status green | `#22c55e` | Online/up indicators |
| Status red | `#f87171` | Errors, offline |
| VLAN highlight | `#7dd3fc` | VLAN numbers (from dashboard rack table) |
| Font | Inter, system-ui, sans-serif | Global font |
| Max width | 1100px | Centered page layout |

### No Backend Changes Required
All port data is already embedded in the topology response (`GET /api/topology` returns `DeviceOut` with `ports: List[PortOut]`). The Zustand store caches this data, so the detail page reads it directly.

### Data Flow
1. User clicks `[i]` button on `SwitchPanel` in `RackDetail`
2. `navigate("/switch/5")` fires
3. React Router renders `SwitchDetailPage` inside `<App />` layout
4. Page reads `id=5` from `useParams()`
5. Finds device: `topology.nodes.find(n => n.id === 5)`
6. If store empty (direct URL), `loadTopology()` fetches and populates
7. Port table renders from `device.ports` with sort state
