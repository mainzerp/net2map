# Detail Panel Link Colors & Partner IP - Implementation Plan

## Overview

Three changes to the SwitchDetailSlideIn panel:
1. Widen panel (maxWidth 1200 -> 1400)
2. Color port rows based on topology link colors (consistent with rack view)
3. Show link partner IP in the IP column

## Files to Change

| File | Change |
|------|--------|
| `frontend/src/pages/MapPage.jsx` | Pass 3 new props to SwitchDetailSlideIn |
| `frontend/src/components/SwitchDetailSlideIn.jsx` | Widen panel, compute link maps, color rows, show partner IP |

---

## Step 1: MapPage.jsx - Pass New Props

**Location:** Lines 264-268 (the `<SwitchDetailSlideIn>` render)

Change from:
```jsx
<SwitchDetailSlideIn
  deviceId={detailSwitchId}
  nodes={topology.nodes}
  onClose={() => setDetailSwitchId(null)}
/>
```

Change to:
```jsx
<SwitchDetailSlideIn
  deviceId={detailSwitchId}
  nodes={topology.nodes}
  topologyLinks={topology.links}
  rackPairColorMap={rackPairColorMap}
  allRacks={allRacks}
  onClose={() => setDetailSwitchId(null)}
/>
```

All three variables (`topology.links`, `rackPairColorMap`, `allRacks`) are already computed in MapPage scope - no additional logic needed.

---

## Step 2: SwitchDetailSlideIn.jsx - Import Helpers

**Location:** Line 2 (import statement)

Change from:
```js
import { speedLabel } from "../api.js";
```

Change to:
```js
import { speedLabel, buildPortLinkMap, normPort, CABLE_COLORS } from "../api.js";
```

---

## Step 3: SwitchDetailSlideIn.jsx - Accept New Props

**Location:** Line 4 (function signature)

Change from:
```jsx
export default function SwitchDetailSlideIn({ deviceId, nodes, onClose }) {
```

Change to:
```jsx
export default function SwitchDetailSlideIn({ deviceId, nodes, topologyLinks, rackPairColorMap, allRacks, onClose }) {
```

---

## Step 4: SwitchDetailSlideIn.jsx - Compute portLinkMap and linkColorMap

**Location:** After the `device` useMemo (after line 12), add two new useMemo blocks.

### 4a. portLinkMap

Filter `topologyLinks` to only links involving this device's IP, then build the port link map.

```jsx
const deviceLinks = useMemo(() => {
  if (!device || !topologyLinks) return [];
  return topologyLinks.filter(
    l => l.local_ip === device.ip || l.remote_ip === device.ip
  );
}, [device, topologyLinks]);

const portLinkMap = useMemo(() => buildPortLinkMap(deviceLinks), [deviceLinks]);
```

### 4b. linkColorMap

Replicate the same color-assignment logic from RackDetail: use `rackPairColorMap` for rack-pair consistency, fall back to `CABLE_COLORS` per switch pair.

```jsx
const linkColorMap = useMemo(() => {
  const ipToRackId = {};
  (allRacks || []).forEach(r => {
    if (r.id) (r.devices || []).forEach(d => { ipToRackId[d.ip] = String(r.id); });
  });
  const m = {};
  const pairColors = {};
  let colorIdx = 0;
  deviceLinks.forEach(l => {
    const pairKey = [l.local_ip, l.remote_ip].sort().join("|");
    if (!(pairKey in pairColors)) {
      const ra = ipToRackId[l.local_ip];
      const rb = ipToRackId[l.remote_ip];
      const rackKey = ra && rb ? [ra, rb].sort().join("|") : null;
      const rackColor = rackKey ? rackPairColorMap?.[rackKey] : null;
      pairColors[pairKey] = rackColor || CABLE_COLORS[colorIdx % CABLE_COLORS.length];
      if (!rackColor) colorIdx++;
    }
    const c = pairColors[pairKey];
    m[`${l.local_ip}:${normPort(l.local_port)}`] = c;
    m[`${l.remote_ip}:${normPort(l.remote_port)}`] = c;
  });
  return m;
}, [deviceLinks, allRacks, rackPairColorMap]);
```

This is identical to the logic in `RackDetail.jsx` lines 207-226.

---

## Step 5: SwitchDetailSlideIn.jsx - Widen Panel

**Location:** The slide-in panel `<div>` style (currently line 68)

Change:
```js
width: "75vw",
maxWidth: 1200,
```

To:
```js
width: "80vw",
maxWidth: 1400,
```

---

## Step 6: SwitchDetailSlideIn.jsx - Color Port Rows and Show Partner IP

**Location:** The `<tbody>` section where each port `<tr>` is rendered (currently around line 117).

For each port row, compute:
1. `portKey` = `"<device.ip>:<normPort(port.if_descr)>"`
2. `cableColor` = `linkColorMap[portKey]` (undefined if no link)
3. `linkEntry` = `portLinkMap[portKey]` (undefined if no link)
4. `partnerIp` = from `linkEntry`, the remote side's IP

### Row styling

Apply a left border in the cable color when the port has a topology link:

Replace the current `<tr>` rendering:
```jsx
{sortedPorts.map(port => (
  <tr key={port.id} style={{ borderBottom: "1px solid #0f172a" }}>
```

With:
```jsx
{sortedPorts.map(port => {
  const pKey = `${device.ip}:${normPort(port.if_descr)}`;
  const cableColor = linkColorMap[pKey];
  const linkEntry = portLinkMap[pKey];
  const partnerIp = linkEntry
    ? (linkEntry.role === "from" ? linkEntry.link.remote_ip : linkEntry.link.local_ip)
    : null;
  return (
    <tr key={port.id} style={{
      borderBottom: "1px solid #0f172a",
      borderLeft: cableColor ? `3px solid ${cableColor}` : "3px solid transparent",
      backgroundColor: cableColor ? `${cableColor}08` : undefined,
    }}>
```

This gives each linked port row a colored left border matching the rack view cable color, plus a very subtle background tint.

### IP column

Show link partner IP alongside or in place of `peer_ip`. When both exist, show both. When only partner IP exists, show it. The partner IP is styled in the cable color to distinguish it.

Replace the current IP `<td>`:
```jsx
<td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
  {port.peer_ip || "-"}
</td>
```

With:
```jsx
<td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
  {partnerIp && (
    <span style={{ color: cableColor || "#22d3ee" }} title="Link partner">
      {partnerIp}
    </span>
  )}
  {partnerIp && port.peer_ip && (
    <span style={{ color: "#334155" }}>{" | "}</span>
  )}
  {port.peer_ip && (
    <span>{port.peer_ip}</span>
  )}
  {!partnerIp && !port.peer_ip && "-"}
</td>
```

### Close the `<tr>` with `)}` instead of `)`

The row now uses an arrow function body `{...return(...)}` so the closing of `sortedPorts.map` changes from `))}` to `)})}`.

---

## Step 7: Complete Modified SwitchDetailSlideIn.jsx Port Row Block

For clarity, here is the full replacement of the `<tbody>` content (from `{sortedPorts.map(...)` through its closing):

```jsx
<tbody>
  {sortedPorts.map(port => {
    const pKey = `${device.ip}:${normPort(port.if_descr)}`;
    const cableColor = linkColorMap[pKey];
    const linkEntry = portLinkMap[pKey];
    const partnerIp = linkEntry
      ? (linkEntry.role === "from" ? linkEntry.link.remote_ip : linkEntry.link.local_ip)
      : null;
    return (
      <tr key={port.id} style={{
        borderBottom: "1px solid #0f172a",
        borderLeft: cableColor ? `3px solid ${cableColor}` : "3px solid transparent",
        backgroundColor: cableColor ? `${cableColor}08` : undefined,
      }}>
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
          {partnerIp && (
            <span style={{ color: cableColor || "#22d3ee" }} title="Link partner">
              {partnerIp}
            </span>
          )}
          {partnerIp && port.peer_ip && (
            <span style={{ color: "#334155" }}>{" | "}</span>
          )}
          {port.peer_ip && (
            <span>{port.peer_ip}</span>
          )}
          {!partnerIp && !port.peer_ip && "-"}
        </td>
        <td style={{ padding: "8px 10px", color: "#94a3b8" }}>
          {port.peer_host || "-"}
        </td>
      </tr>
    );
  })}
</tbody>
```

---

## Checklist

- [ ] **Step 1:** MapPage.jsx - Add `topologyLinks`, `rackPairColorMap`, `allRacks` props to `<SwitchDetailSlideIn>`
- [ ] **Step 2:** SwitchDetailSlideIn.jsx - Import `buildPortLinkMap`, `normPort`, `CABLE_COLORS` from api.js
- [ ] **Step 3:** SwitchDetailSlideIn.jsx - Accept new props in function signature
- [ ] **Step 4:** SwitchDetailSlideIn.jsx - Add `deviceLinks`, `portLinkMap`, `linkColorMap` useMemo blocks
- [ ] **Step 5:** SwitchDetailSlideIn.jsx - Change width to `80vw` / maxWidth to `1400`
- [ ] **Step 6:** SwitchDetailSlideIn.jsx - Rewrite `<tbody>` to color rows and show partner IP
- [ ] Verify: Opening detail panel shows colored left borders matching rack view link colors
- [ ] Verify: IP column shows link partner IP in cable color, with ` | ` separator when peer_ip also exists
