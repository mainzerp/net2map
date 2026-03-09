# Slide-In Switch Detail Panel - Implementation Plan

## Summary

Convert the switch detail view from a separate page route (`/switch/:id`) to a slide-in panel that overlays from the right side of the map page. Fix the `[i]` button visibility. Remove the standalone route and page file.

---

## Checklist

- [ ] Step 1: Create `SwitchDetailSlideIn.jsx` component
- [ ] Step 2: Add `detailSwitchId` state to `MapPage.jsx` and render the slide-in
- [ ] Step 3: Thread `onShowDetail` prop through `RackDetail.jsx` to `SwitchPanel`
- [ ] Step 4: Replace `navigate()` with `onShowDetail` callback in `SwitchPanel.jsx` and fix button color
- [ ] Step 5: Remove the `/switch/:id` route from `main.jsx` and delete `SwitchDetailPage.jsx`
- [ ] Step 6: Update `VERSION.md`

---

## Step 1: Create `SwitchDetailSlideIn.jsx`

**File:** `frontend/src/components/SwitchDetailSlideIn.jsx` (NEW)

This component is extracted from the content of `SwitchDetailPage.jsx` but adapted to work as a slide-in overlay panel instead of a routed page.

**Key differences from SwitchDetailPage:**
- No `useParams` / `useNavigate` -- receives `deviceId`, `nodes`, and `onClose` as props
- Looks up device from `nodes` prop (the topology nodes array from MapPage)
- No "Back" button; has an "X" close button in the header instead
- Wrapped in a fixed-position container with backdrop and CSS transition
- Uses `transform: translateX(0/100%)` with `transition` for slide animation

```jsx
// frontend/src/components/SwitchDetailSlideIn.jsx
import { useState, useMemo } from "react";
import { speedLabel } from "../api.js";

export default function SwitchDetailSlideIn({ deviceId, nodes, onClose }) {
  const [sortCol, setSortCol] = useState("if_index");
  const [sortAsc, setSortAsc] = useState(true);

  const device = useMemo(
    () => (nodes || []).find(n => n.id === Number(deviceId)),
    [nodes, deviceId]
  );

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
      if (sortCol === "tagged_vlans") {
        va = (va || []).length;
        vb = (vb || []).length;
      }
      if (typeof va === "string" && typeof vb === "string")
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      va = va ?? 0;
      vb = vb ?? 0;
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [device, sortCol, sortAsc]);

  if (!device) return null;

  const pingStatus = device.ping_status || "unknown";
  const statusColor = pingStatus === "online" ? "#22c55e"
    : pingStatus === "offline" ? "#f87171" : "#64748b";
  const activePorts = device.ports.filter(p => p.oper_status === 1);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
          zIndex: 1000,
        }}
      />

      {/* Slide-in panel */}
      <div style={{
        position: "fixed",
        top: 48, right: 0, bottom: 0,
        width: 560,
        backgroundColor: "#020817",
        borderLeft: "1px solid #1e293b",
        zIndex: 1001,
        display: "flex", flexDirection: "column",
        fontFamily: "'Inter', system-ui, sans-serif",
        animation: "slideInDetail 0.25s ease",
      }}>
        <style>{`
          @keyframes slideInDetail {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>

        {/* Header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: "1px solid #1e293b",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div>
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
          <button onClick={onClose} style={{
            background: "none", border: "1px solid #1e293b",
            color: "#64748b", borderRadius: 6, padding: "4px 10px",
            cursor: "pointer", fontSize: 16, flexShrink: 0,
          }}>X</button>
        </div>

        {/* Port table (scrollable) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
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
      </div>
    </>
  );
}
```

---

## Step 2: Add state and render slide-in in `MapPage.jsx`

**File:** `frontend/src/pages/MapPage.jsx`

### 2a: Add import for the new component

**Location:** After line 7 (after the `RackDetail` import)

Add:
```jsx
import SwitchDetailSlideIn from "../components/SwitchDetailSlideIn.jsx";
```

### 2b: Add `detailSwitchId` state

**Location:** Line 32 (after the `selectedOutsideNode` state declaration)

Add this line after `const [selectedOutsideNode, setSelectedOutsideNode] = useState(null);`:
```jsx
const [detailSwitchId, setDetailSwitchId] = useState(null);
```

### 2c: Render the slide-in panel

**Location:** Inside the return JSX, just before the closing `</div>` of the outermost container (the `div` with `height:"calc(100vh - 48px)"`). This places it as a sibling to the toolbar and the main flex row, using fixed positioning to overlay.

Insert before the final `</div>` of the return statement (after the closing `</div>` of the flex row `div`):

```jsx
      {detailSwitchId != null && (
        <SwitchDetailSlideIn
          deviceId={detailSwitchId}
          nodes={topology.nodes}
          onClose={() => setDetailSwitchId(null)}
        />
      )}
```

### 2d: Pass `onShowDetail` to RackDetail

In the `<RackDetail>` JSX (around line 236), add a new prop:

```jsx
onShowDetail={setDetailSwitchId}
```

**Exact change:** In the `<RackDetail ...>` block, add the prop alongside the existing ones. Insert it after the `onLinkSelect={setSelectedLink}` prop:

```
              onLinkSelect={setSelectedLink}
              onShowDetail={setDetailSwitchId}
```

---

## Step 3: Thread `onShowDetail` through `RackDetail.jsx`

**File:** `frontend/src/components/map/RackDetail.jsx`

### 3a: Accept the new prop

**Location:** Line 6, the function signature

Change from:
```jsx
function RackDetail({ rack, allRacks, switchClasses, switchModels, topologyLinks, deviceOrder, onReorder, onReorderClass, onClose, onRename, onMoveDevice, onUpdateDeviceMeta, rackPairColorMap, selectedLink, onLinkSelect }) {
```

To:
```jsx
function RackDetail({ rack, allRacks, switchClasses, switchModels, topologyLinks, deviceOrder, onReorder, onReorderClass, onClose, onRename, onMoveDevice, onUpdateDeviceMeta, rackPairColorMap, selectedLink, onLinkSelect, onShowDetail }) {
```

### 3b: Pass `onShowDetail` to each `SwitchPanel`

**Location:** Inside the `renderGroup` function (around line 245), in the `<SwitchPanel>` JSX.

Change from:
```jsx
        <SwitchPanel device={d} otherRacks={otherRacks} onMove={onMoveDevice}
          onUpdateMeta={onUpdateDeviceMeta}
          portLinkMap={portLinkMap} selectedLink={resolvedSelectedLink}
          onPortClick={toggleLink} linkColorMap={linkColorMap}
          interRackPortKeys={interRackPortKeys}
          switchClass={d.class_id ? classMap[d.class_id] : null}
          switchModel={d.model_id ? modelMap[d.model_id] : null}/>
```

To:
```jsx
        <SwitchPanel device={d} otherRacks={otherRacks} onMove={onMoveDevice}
          onUpdateMeta={onUpdateDeviceMeta}
          portLinkMap={portLinkMap} selectedLink={resolvedSelectedLink}
          onPortClick={toggleLink} linkColorMap={linkColorMap}
          interRackPortKeys={interRackPortKeys}
          switchClass={d.class_id ? classMap[d.class_id] : null}
          switchModel={d.model_id ? modelMap[d.model_id] : null}
          onShowDetail={onShowDetail}/>
```

---

## Step 4: Update `SwitchPanel.jsx` -- replace navigate with callback and fix button color

**File:** `frontend/src/components/SwitchPanel.jsx`

### 4a: Remove `useNavigate` import and usage

**Location:** Line 2, remove `useNavigate` from the react-router-dom import.

Change:
```jsx
import { useNavigate } from "react-router-dom";
```

Remove this entire import line (it is no longer needed since `navigate` is replaced by the `onShowDetail` prop).

### 4b: Update component signature to accept `onShowDetail`

**Location:** Line 7, the component's props destructuring.

Change:
```jsx
export default function SwitchPanel({ device, otherRacks = [], onMove, onUpdateMeta, portLinkMap, selectedLink, onPortClick, linkColorMap, switchClass, switchModel, interRackPortKeys }) {
```

To:
```jsx
export default function SwitchPanel({ device, otherRacks = [], onMove, onUpdateMeta, portLinkMap, selectedLink, onPortClick, linkColorMap, switchClass, switchModel, interRackPortKeys, onShowDetail }) {
```

### 4c: Remove `const navigate = useNavigate();`

**Location:** Line 8

Remove:
```jsx
  const navigate = useNavigate();
```

### 4d: Update the `[i]` button onClick and fix color

**Location:** Lines 57-67, the `[i]` button div.

Change from:
```jsx
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
```

To:
```jsx
          <div
            title="Switch details"
            onClick={e => { e.stopPropagation(); onShowDetail?.(device.id); }}
            style={{
              fontSize:11, color:"#94a3b8",
              padding:"2px 5px", borderRadius:4,
              border:"1px solid #334155",
              backgroundColor:"transparent",
              cursor:"pointer", userSelect:"none",
            }}
          >[i]</div>
```

Changes made:
- `navigate(...)` replaced with `onShowDetail?.(device.id)` -- calls the callback prop
- `color` changed from `"#475569"` to `"#94a3b8"` -- much brighter slate for visibility
- `border` changed from `"1px solid #1e293b"` to `"1px solid #334155"` -- slightly brighter border to match

---

## Step 5: Remove the `/switch/:id` route and delete `SwitchDetailPage.jsx`

### 5a: Remove the route from `main.jsx`

**File:** `frontend/src/main.jsx`

**Location:** Lines 9 and 25

Remove the import:
```jsx
import SwitchDetailPage from "./pages/SwitchDetailPage.jsx";
```

Remove the route:
```jsx
          <Route path="switch/:id" element={<ErrorBoundary><SwitchDetailPage /></ErrorBoundary>} />
```

### 5b: Delete `SwitchDetailPage.jsx`

**File to delete:** `frontend/src/pages/SwitchDetailPage.jsx`

Run in terminal:
```
Remove-Item "frontend/src/pages/SwitchDetailPage.jsx"
```

---

## Step 6: Update `VERSION.md`

Add a changelog entry for this feature under "Recent Changes":

```
- Switch detail view converted from separate page to slide-in panel overlay on map
- [i] button color fixed for visibility (#475569 -> #94a3b8)
- Removed /switch/:id route (SwitchDetailPage.jsx deleted)
```

---

## z-index Layering Reference

| Element | z-index | Notes |
|---------|---------|-------|
| Backdrop (SwitchDetailSlideIn) | 1000 | Semi-transparent overlay |
| Panel (SwitchDetailSlideIn) | 1001 | Slide-in panel above backdrop |
| Link highlight SVG (RackDetail) | 9998 | Existing cable line overlay |
| PortDetailModal | 10000 | Existing port double-click modal |

The slide-in panel sits below existing overlays (port detail modal, cable highlight SVG) so they remain functional.

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/components/SwitchDetailSlideIn.jsx` | CREATE | New slide-in panel component |
| `frontend/src/pages/MapPage.jsx` | EDIT | Add state, import, render slide-in, pass prop to RackDetail |
| `frontend/src/components/map/RackDetail.jsx` | EDIT | Accept and thread `onShowDetail` prop to SwitchPanel |
| `frontend/src/components/SwitchPanel.jsx` | EDIT | Replace navigate with callback, fix button color |
| `frontend/src/main.jsx` | EDIT | Remove switch route and import |
| `frontend/src/pages/SwitchDetailPage.jsx` | DELETE | No longer needed |
| `VERSION.md` | EDIT | Add changelog entry |
