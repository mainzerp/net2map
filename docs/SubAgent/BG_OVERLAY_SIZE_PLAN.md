# BG Overlay Size - Implementation Plan

**Date:** 2026-02-25
**Based on:** docs/SubAgent/BG_OVERLAY_SIZE_ANALYSIS.md
**Scope:** Restrict transparent pan-hit rect to the background outer box only.

---

## Constraints

- Change only `frontend/src/components/map/TopologyMap.jsx`.
- Fix only the transparent rect hit area so it matches the outer background box (`bgX`, `bgY`, `bgW`, `bgH`).
- Keep all other map interactions unchanged (zoom behavior, rack/outside-node interactions, links, selection).
- No backend/API/state-shape changes.

---

## Implementation Checklist

- [ ] Open `frontend/src/components/map/TopologyMap.jsx` and locate the transparent pan target rendered when `mapBgUrl` is set.
- [ ] Replace full-viewport rect geometry (`x=0`, `y=0`, `width=100%`, `height=100%`) with outer background box geometry (`x={bgX}`, `y={bgY}`, `width={bgW}`, `height={bgH}`).
- [ ] Ensure the transparent hit rect remains under the same zoom transform as the background image so hit-testing tracks pan/zoom identically.
- [ ] Keep existing `onMouseDown={onBgMouseDown}` and cursor semantics unchanged.
- [ ] Confirm no changes are introduced to rack drag handlers, outside-node drag handlers, link rendering, or selection logic.

---

## Validation Checklist

### A) Diagnostics (interaction behavior)

- [ ] With `mapBgUrl` present, verify panning starts only when mouse-down occurs inside the background outer box.
- [ ] Verify panning no longer starts from empty map margins outside the outer box.
- [ ] Verify pan motion after initiation is unchanged (same drag feel and continuity).
- [ ] Verify rack interactions are unchanged: select/drag still work as before.
- [ ] Verify outside-node interactions are unchanged: select/drag still work as before.
- [ ] Verify link rendering and hover/selection behavior remain unchanged.

### B) Frontend build

- [ ] Run frontend build (`npm run build`) and confirm successful completion with no new build errors.
