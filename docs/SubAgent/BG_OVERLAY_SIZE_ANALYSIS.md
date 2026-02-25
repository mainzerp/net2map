# Analysis: Match Transparent Map Overlay to Background Box

## Scope
Adjust only the SVG transparent interaction overlay used when `mapBgUrl` is present so its hit area matches the background image outer box dimensions, not the full map viewport.

This document is research/spec only. No implementation is included.

---

## 1) Current Layer Behavior (`TopologyMap.jsx`)

File inspected: `frontend/src/components/map/TopologyMap.jsx`

### 1.1 Geometry sources
- Map canvas is fixed to `W=900`, `H=550`.
- Background outer box is computed from scale:
  - `bgW = W * bgS`
  - `bgH = H * bgS`
  - `bgX = W/2 - bgW/2`
  - `bgY = H/2 - bgH/2`
- `bgFit` is the aspect-fit inner rectangle (used for clipping to visible image content).

### 1.2 Current SVG layer stack (relevant parts)
- `bgClip` clipPath uses `bgFit` rect.
- Transparent panning target when image exists:
  - `<rect x={0} y={0} width="100%" height="100%" fill="transparent" onMouseDown={onBgMouseDown} .../>`
  - This currently covers the entire viewport.
- Image layer:
  - Wrapped in `<g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`} clipPath="url(#bgClip)">`
  - `<image ... x={bgX} y={bgY} width={bgW} height={bgH} preserveAspectRatio="xMidYMid meet"/>`
- Dim/opacity overlay:
  - Full viewport rect with `pointerEvents:"none"`.

### 1.3 Why behavior is wrong for requested UX
- The transparent interaction rect is full-map (`0..W`, `0..H`) rather than image outer box (`bgX..bgX+bgW`, `bgY..bgY+bgH`).
- Result: panning can start anywhere on the viewport when `mapBgUrl` is set, not only over the background box.

---

## 2) Minimal Safe Change

## 2.1 Proposed change (single-file, surgical)
Update only the image-present transparent panning target so it:
1. Uses box geometry `x={bgX}`, `y={bgY}`, `width={bgW}`, `height={bgH}`.
2. Is placed under the same zoom transform as the image (`translate/scale`) so hit area tracks pan/zoom position.
3. Keeps `onMouseDown={onBgMouseDown}` and cursor behavior unchanged.

## 2.2 Why this is minimal and safe
- No changes to zoom math (`onBgMouseDown`, `onMouseMove`, `onMouseUp`).
- No changes to node drag/select (`onRackMouseDown`, `onOutsideMouseDown`) or link rendering.
- No API/props/state shape changes.
- Only interaction bounds of pan-start are narrowed to intended box area.

---

## 3) Panning Side-Effect Assessment

Expected side effects after change:
1. **Pan start area shrinks intentionally**: with image enabled, panning starts only when mouse-down occurs within the transformed background box.
2. **Outside margins no longer start pan**: empty map areas outside the box stop initiating pan.
3. **Pan motion remains identical once started**: move/up logic still runs at SVG root, so active pan drag behavior is unchanged.
4. **Node interactions unaffected**: node/rack mouse-down handlers already stop propagation and keep drag/select behavior intact.

Risk level: **Low** (interaction-boundary change only).

---

## 4) Exact File(s) to Change

1. `frontend/src/components/map/TopologyMap.jsx`

No other frontend or backend files are required for this request.

---

## 5) Acceptance Criteria

1. With `mapBgUrl` present, transparent pan hit-area matches the visible background outer box dimensions (not full map).
2. Pan can no longer be initiated from empty area outside that box.
3. Existing zoom, rack drag/select, outside-node drag/select, and link interactions remain unchanged.
