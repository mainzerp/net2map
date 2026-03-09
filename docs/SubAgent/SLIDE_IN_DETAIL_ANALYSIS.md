# Slide-In Switch Detail Panel - Analysis

## 1. Bug: [i] Button Text Not Visible

### Location
[frontend/src/components/SwitchPanel.jsx](frontend/src/components/SwitchPanel.jsx#L57-L67)

### Root Cause
The `[i]` button is rendered as a plain `<div>` with `fontSize: 11` and `color: "#475569"`. The color `#475569` is a very dark slate gray on the `#0f172a` background. While technically visible, it has extremely low contrast and is hard to see, especially on dark monitors.

The text content `[i]` is plain text inside a div, not using any icon font or SVG, so there is no missing font issue. The problem is purely **contrast** -- `#475569` text on `#0f172a` background is near-invisible.

### Fix
Change the `[i]` button color to something more visible like `#94a3b8` (brighter slate) or `#64748b` (medium slate). Add a hover color to make it interactive. Could also add a title tooltip (already has `title="Switch details"`).

---

## 2. Current Architecture

### Routing Structure
File: [frontend/src/main.jsx](frontend/src/main.jsx)

```
<Routes>
  <Route element={<App />}>
    <Route index element={<DashboardPage />} />
    <Route path="map" element={<MapPage />} />
    <Route path="switch/:id" element={<SwitchDetailPage />} />
    ...
  </Route>
</Routes>
```

- `SwitchDetailPage` is a **separate route** at `/switch/:id`
- The `[i]` button in `SwitchPanel` calls `navigate(/switch/${device.id})` to navigate away from the map page entirely

### SwitchDetailPage Component
File: [frontend/src/pages/SwitchDetailPage.jsx](frontend/src/pages/SwitchDetailPage.jsx)

- Gets device ID from URL params via `useParams()`
- Looks up the device from the Zustand store (`useNetmapStore`)
- If store is empty (direct URL navigation), calls `loadTopology()`
- Renders a header card with switch metadata (IP, vendor, model, location, ports, RTT)
- Renders a sortable port table with columns: PORT #, NAME, STATUS, SPEED, NATIVE VLAN, TAGGED VLANS, MAC, IP, HOSTNAME
- Has a "Back" button that calls `navigate(-1)`

### MapPage Layout
File: [frontend/src/pages/MapPage.jsx](frontend/src/pages/MapPage.jsx)

```
MapPage
  +-- Toolbar (top bar with stats + reload button)
  +-- Main flex row (flex:1, overflow:hidden)
      +-- Left column (flex:1): FilterBar + TopologyMap
      +-- Right panel (width: panelWidth, conditional): RackDetail
```

- When a rack is selected, `RackDetail` renders inline on the right side
- The map shrinks to accommodate the panel (not an overlay, but an inline flex sibling)
- `panelWidth` is dynamically calculated based on widest switch's ports_per_row

### RackDetail Component
File: [frontend/src/components/map/RackDetail.jsx](frontend/src/components/map/RackDetail.jsx)

- Renders as an inline panel that takes space from the flex layout
- Already has a `slideIn` CSS animation: `@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`
- Contains header with rack name (editable), close button
- Scrollable content area with:
  - Switch panels grouped by class sections (with reorder buttons)
  - Uplinks, Trunks, Inter-rack links sections
  - Cable map section
- Each switch is rendered via `SwitchPanel` component
- The `[i]` button inside `SwitchPanel` navigates away from the entire MapPage

### SwitchPanel Component
File: [frontend/src/components/SwitchPanel.jsx](frontend/src/components/SwitchPanel.jsx)

- Collapsible panel showing switch info + port grid
- The `[i]` button triggers `navigate(/switch/${device.id})`
- Port grid renders using the `Port` component with link highlighting

### Existing Overlay Patterns
File: [frontend/src/components/PortDetailModal.jsx](frontend/src/components/PortDetailModal.jsx)

- Uses `position: fixed; inset: 0; zIndex: 10000` with dark backdrop
- Centered modal pattern (not slide-in)
- Triggered by double-clicking a port in the Port component

---

## 3. Slide-In Panel Implementation Plan

### Approach: Local State in MapPage (Recommended)

**Do NOT use routing** for the slide-in panel. Instead:
- Add a `selectedSwitchId` state to `MapPage`
- Pass a callback to `RackDetail` -> `SwitchPanel` to set this state (instead of `navigate()`)
- Render a `SwitchDetailPanel` (new component adapted from `SwitchDetailPage`) as a fixed/absolute overlay on the right

### Why Not Keep the Route
- The slide-in panel overlays the rack overview - it needs access to the same page context
- Routing would cause a full page transition, losing the overlay effect
- The panel should dismiss on click-outside or close button, which is state-driven, not route-driven
- The existing `SwitchDetailPage` route can remain for direct URL access (bookmarking), but the primary UX should be the panel

### Component Hierarchy After Change

```
MapPage
  +-- Toolbar
  +-- Main flex row
  |   +-- Left column: FilterBar + TopologyMap
  |   +-- Right panel (conditional): RackDetail
  |       +-- SwitchPanel (each switch)
  |           +-- [i] button -> sets selectedSwitchId (NOT navigate)
  +-- SwitchDetailSlideIn (fixed/absolute overlay, conditional on selectedSwitchId)
```

### CSS Implementation

The slide-in should use:
```css
position: fixed;
top: 48px;          /* below the App header */
right: 0;
bottom: 0;
width: 520px;       /* or similar */
z-index: 1000;      /* above RackDetail but below PortDetailModal's 10000 */
transform: translateX(100%);  /* hidden state */
transition: transform 0.25s ease;
```

When open:
```css
transform: translateX(0);
```

Add a semi-transparent backdrop to dismiss on click-outside.

### State Management

In `MapPage`:
```jsx
const [detailSwitchId, setDetailSwitchId] = useState(null);
```

Pass `onShowDetail={(id) => setDetailSwitchId(id)}` through:
- `MapPage` -> `RackDetail` (as a new prop)
- `RackDetail` -> `SwitchPanel` (as a new prop)
- `SwitchPanel` replaces `navigate(/switch/${device.id})` with the callback

### New Component: SwitchDetailSlideIn

Create a new component extracted from `SwitchDetailPage` content:
- Accepts `deviceId` and `onClose` props
- Gets device data from topology (passed as prop or from store)
- Renders the same header card + sortable port table
- Wrapped in the slide-in container with close button and backdrop

---

## 4. File Inventory

| File | Role | Changes Needed |
|------|------|----------------|
| `frontend/src/pages/MapPage.jsx` | Page container | Add `detailSwitchId` state, pass callback down, render slide-in |
| `frontend/src/components/SwitchPanel.jsx` | Switch in rack | Replace `navigate()` with callback prop; fix `[i]` button color |
| `frontend/src/components/map/RackDetail.jsx` | Rack panel | Thread `onShowDetail` prop through to SwitchPanel |
| `frontend/src/components/SwitchDetailSlideIn.jsx` | **NEW** | Slide-in panel component (extracted from SwitchDetailPage) |
| `frontend/src/pages/SwitchDetailPage.jsx` | Standalone page | Keep for direct URL access, no changes needed |
| `frontend/src/main.jsx` | Router config | Keep `/switch/:id` route for direct access |

### Component Data Flow

```
MapPage (state: detailSwitchId, topology)
  |
  +-- RackDetail (prop: onShowDetail)
  |     |
  |     +-- SwitchPanel (prop: onShowDetail)
  |           |
  |           +-- [i] button onClick -> onShowDetail(device.id)
  |
  +-- SwitchDetailSlideIn (props: deviceId, topology.nodes, onClose)
        |
        +-- Looks up device from topology.nodes by id
        +-- Renders switch header card
        +-- Renders sortable port table
        +-- Close button / backdrop click -> onClose()
```

---

## 5. Key Decisions

1. **Overlay vs Inline**: Use a fixed overlay (not inline flex like RackDetail), so the rack panel remains visible underneath
2. **z-index layering**: 1000 for backdrop, 1001 for panel (between RackDetail and PortDetailModal at 10000)
3. **Width**: ~520px to match the SwitchDetailPage maxWidth style
4. **Animation**: Use CSS `transform` + `transition` for smooth slide-in (same pattern as RackDetail's existing `slideIn` keyframes, but transition-based for enter/exit)
5. **Backdrop**: Semi-transparent dark overlay for the rest of the viewport, clicks dismiss
6. **Keep route**: `/switch/:id` route stays for direct linking/bookmarking
7. **Button fix**: Change `[i]` color from `#475569` to `#94a3b8` for visibility
