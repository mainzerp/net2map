# Analysis: Map Background Opacity Overlay Covers Only Middle Section

## Issue Summary

The user reports that the opacity overlay (which dims the background image to blend with the map background color) only covers the middle section of the map, rather than the entire visible map area.

---

## 1) Relevant Files

| File | Role |
|------|------|
| `frontend/src/components/map/TopologyMap.jsx` | Renders the SVG map canvas, background image, and opacity overlay |
| `frontend/src/pages/MapPage.jsx` | Hosts the map, passes background props to TopologyMap |
| `frontend/src/hooks/useMapBackground.js` | Hook that reads bg state from the store |
| `frontend/src/store.js` | Zustand store: `bgUrl`, `bgNat`, `bgOpacity`, `bgScale`, `bgColor` |
| `frontend/src/components/settings/MapSettingsTab.jsx` | Settings UI for opacity/scale/color sliders |

---

## 2) SVG Canvas Geometry

`TopologyMap.jsx` renders an SVG element:

```jsx
<svg width="100%" height="100%" viewBox="0 0 900 550" ...>
```

- **viewBox**: fixed at `0 0 900 550` (W=900, H=550).
- **preserveAspectRatio**: not explicitly set, so defaults to `xMidYMid meet`.
  - The viewBox is uniformly scaled to fit inside the SVG viewport (the CSS pixel box) and centered.
  - When the container aspect ratio differs from 900:550 (~1.636:1), **gutter areas** appear around the viewBox mapping area.
  - Content at viewBox coordinates outside 0-900/0-550 CAN map to the gutter areas and be visible.

The SVG container is:
```jsx
<div style={{flex:1, overflow:"hidden", borderRadius:12, margin:"0 12px 12px",
             backgroundColor: mapBgColor || "#020817"}}>
  <TopologyMap ... />
</div>
```

- The container dimensions change dynamically based on window size and whether the right panel (RackDetail) is open.
- Its aspect ratio rarely matches exactly 900:550, so **gutters are almost always present**.

---

## 3) Background Image Geometry

Computed in TopologyMap.jsx (lines ~300-316):

```jsx
const bgS  = mapBgScale ?? 1;               // user-configurable scale (0.1 to 5.0)
const bgW  = W * bgS, bgH = H * bgS;        // outer box dimensions
const bgX  = W/2 - bgW/2, bgY = H/2 - bgH/2; // outer box origin (centered)
```

**At bgScale = 1:** bgX=0, bgY=0, bgW=900, bgH=550 -- fits exactly in the viewBox.

**At bgScale = 2:** bgX=-450, bgY=-275, bgW=1800, bgH=1100 -- extends FAR beyond the viewBox in all directions.

`bgFit` is the aspect-fit rectangle (the actual visible image content area within the outer box), accounting for image natural dimensions:

```jsx
const bgFit = useMemo(() => {
  if (!mapBgNat) return { x: bgX, y: bgY, w: bgW, h: bgH };
  // aspect-fit calculation...
}, [mapBgNat, bgX, bgY, bgW, bgH]);
```

When bgScale > 1, `bgFit` coordinates extend beyond the viewBox bounds (negative x/y, dimensions > 900/550).

---

## 4) SVG Layer Stack (Critical Path)

### Layer 1: Grid (no background image)
```jsx
{!mapBgUrl && (
  <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" opacity={0.4} .../>
)}
```
Only shown when no background image. Not relevant to the bug.

### Panning target (when image present)
```jsx
{mapBgUrl && (
  <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
     clipPath="url(#bgClip)">
    <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h} fill="transparent"
          onMouseDown={onBgMouseDown} .../>
  </g>
)}
```

### Layer 2: Background image
```jsx
{mapBgUrl && (
  <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
     clipPath="url(#bgClip)">
    <image href={mapBgUrl} x={bgX} y={bgY} width={bgW} height={bgH}
           preserveAspectRatio="xMidYMid meet" style={{pointerEvents:"none"}}/>
  </g>
)}
```
- Inside a **zoom transform group** (`translate + scale`).
- Clipped by `bgClip` which uses `bgFit` coordinates in **root SVG coordinate space** (`clipPathUnits="userSpaceOnUse"` is the default).

### Layer 3: Opacity overlay (THE BUG)
```jsx
{mapBgUrl && (
  <rect x={0} y={0} width="100%" height="100%"
        fill={mapBgColor || "#020817"}
        opacity={1 - (mapBgOpacity ?? 0.3)}
        style={{pointerEvents:"none"}}/>
)}
```
- **NOT inside any transform group** -- fixed at root SVG coordinates.
- Covers exactly `(0, 0)` to `(900, 550)` (the viewBox dimensions).
- Does **NOT** move/scale with zoom or pan.

### Layer 4: Content (racks, links, nodes)
```jsx
<g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
  {/* links, racks, outside nodes */}
</g>
```

---

## 5) Root Cause Analysis

### Primary Bug: Overlay does not cover the clip area when bgScale > 1

The clip path `bgClip` is defined using `bgFit` coordinates:
```jsx
<clipPath id="bgClip">
  <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h} rx={18} ry={18}/>
</clipPath>
```

When `bgScale > 1`, these coordinates extend beyond the viewBox (e.g., at bgScale=2: x=-450, y=-275, w=1800, h=1100).

The background image is inside a `<g>` with the zoom transform and this clip. The image content is visible wherever:
1. The transformed image pixels fall within the bgFit clip region (in root coords), AND
2. The root-coord pixels fall within the SVG viewport (CSS box).

Due to `preserveAspectRatio="xMidYMid meet"`, content at negative viewBox coordinates maps to gutter areas in the SVG viewport. These areas ARE visible on screen.

**The opacity overlay at `(0, 0, 900, 550)` does NOT cover the gutter/extended areas.** The background image at bgScale > 1 extends beyond the overlay, resulting in un-dimmed image content visible at the edges while only the center (the viewBox area) is properly dimmed.

### Visual Illustration (bgScale = 2)

```
SVG Viewport (CSS box)
+---------------------------------------------------------+
|  GUTTER: image visible, NO overlay (un-dimmed)          |
|  +---------------------------------------------------+  |
|  |                                                   |  |
|  |  viewBox area (0,0 -- 900,550)                    |  |
|  |  Image visible, overlay dims it correctly          |  |
|  |                                                   |  |
|  +---------------------------------------------------+  |
|  GUTTER: image visible, NO overlay (un-dimmed)          |
+---------------------------------------------------------+
```

### Contributing Factor: preserveAspectRatio default

The SVG uses the default `preserveAspectRatio="xMidYMid meet"`. With a container that doesn't match the 900:550 ratio (which is almost always the case), there are gutter areas where content outside the viewBox can render. This makes the viewBox-bound overlay insufficient.

### Contributing Factor: Overlay not in zoom transform

The overlay is placed at root SVG coordinates, not inside the zoom transform group with the image. This means:
- When the user pans the map (changes zoom.tx/ty), the image moves but the overlay stays fixed.
- The clip (bgClip) is also in root coordinates, so the visible image area stays within bgFit regardless of pan. This somewhat mitigates the pan issue since both clip and overlay are in root coords.
- BUT the overlay only covers viewBox bounds, while the clip covers bgFit bounds (which can be much larger).

---

## 6) Reproduction Steps

1. Upload a background image in Settings > Map Background.
2. Set Image Zoom (bgScale) to > 100% (e.g., 200%).
3. Navigate to the map page.
4. Observe: the background image is visible across the full map area, but the opacity dimming only applies to the center portion. The edges of the image appear at full brightness.

At bgScale = 100%, the issue is less visible but can still appear when the container aspect ratio doesn't match 900:550.

---

## 7) Fix Direction

### Recommended Fix: Move overlay inside the clip group or match its coordinates to bgFit

**Option A (Cleanest):** Place the overlay rect inside the same `<g>` group as the image, after the `<image>` element, within the same clip:

```jsx
{mapBgUrl && (
  <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
     clipPath="url(#bgClip)">
    <image href={mapBgUrl} x={bgX} y={bgY} width={bgW} height={bgH}
           preserveAspectRatio="xMidYMid meet" style={{pointerEvents:"none"}}/>
    <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h}
          fill={mapBgColor || "#020817"}
          opacity={1 - (mapBgOpacity ?? 0.3)}
          style={{pointerEvents:"none"}}/>
  </g>
)}
```

This ensures the overlay:
- Covers exactly the same area as the visible image (same clip path).
- Moves with zoom/pan (same transform group).
- Automatically handles any bgScale value.

The existing standalone Layer 3 `<rect>` would be removed.

**Option B (Minimal):** Change the standalone overlay rect to use bgFit coordinates instead of viewBox coordinates:

```jsx
<rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h}
      fill={mapBgColor || "#020817"} opacity={1 - (mapBgOpacity ?? 0.3)}
      style={{pointerEvents:"none"}}/>
```

This covers the full image clip area but does NOT move with zoom/pan. Since the clip is also in root coordinates, both stay aligned. However, during pan, the image within the clip shifts -- but the dimming stays with the clip bounds, not the image content. This is acceptable since the clip already constrains visibility.

**Option A is preferred** because it handles all edge cases and the overlay semantically belongs with the image layer.

### Side-effect: Overlay above content

Currently the overlay is between the background image (Layer 2) and the content (Layer 4). If the overlay is moved inside the image's clip group, it stays below the content group -- which is the correct behavior. The content should not be dimmed by the background overlay. This is maintained regardless of which option is chosen.

---

## 8) Files to Change

1. **`frontend/src/components/map/TopologyMap.jsx`** -- single file change
   - Move or merge the opacity overlay rect into the background image clip group.
   - Remove the standalone Layer 3 overlay rect.

No backend, store, hook, or settings changes required.

---

## 9) Previous Related Analysis

- `docs/SubAgent/BG_OVERLAY_SIZE_ANALYSIS.md` -- addressed the transparent panning hit-area rect being full-viewport instead of limited to the background box. That issue was about **interaction bounds** (panning). This analysis is about **visual dimming bounds** (opacity overlay). The previous fix already constrained the pan target to `bgFit` bounds; this fix needs to similarly constrain (or co-locate) the opacity overlay.
- `docs/SubAgent/BG_OVERLAY_SIZE_PLAN.md` -- implementation plan for the pan hit-area fix. Not directly applicable here but confirms the file and geometry variables to modify.
