# Slide-In Panel Fixes - Analysis & Plan

## Findings

### 1. Panel Width (SwitchDetailSlideIn.jsx)

**Location:** `frontend/src/components/SwitchDetailSlideIn.jsx`, line ~70

Current value: `width: 560` (560px fixed)

The panel has 9 columns in the port table (PORT #, NAME, STATUS, SPEED, NATIVE VLAN, TAGGED VLANS, MAC ADDRESS, IP, HOSTNAME). At 560px these columns are cramped, especially TAGGED VLANS and MAC ADDRESS.

### 2. [i] Button (SwitchPanel.jsx)

**Location:** `frontend/src/components/SwitchPanel.jsx`, lines ~55-63

Current code renders a small `[i]` text as a clickable div with minimal padding. It's not immediately obvious this is a clickable button or what it does without hovering for the tooltip.

---

## Implementation Plan

### Change 1: Widen the slide-in panel

**File:** `frontend/src/components/SwitchDetailSlideIn.jsx`

**Old code:**
```jsx
        width: 560,
```

**New code:**
```jsx
        width: "75vw",
        maxWidth: 1200,
```

This gives the panel 75% of the viewport width (capped at 1200px), providing ample room for all 9 table columns.

### Change 2: Replace [i] with "Details" button

**File:** `frontend/src/components/SwitchPanel.jsx`

**Old code:**
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

**New code:**
```jsx
          <div
            title="Switch details"
            onClick={e => { e.stopPropagation(); onShowDetail?.(device.id); }}
            style={{
              fontSize:10, color:"#94a3b8",
              padding:"3px 8px", borderRadius:4,
              border:"1px solid #334155",
              backgroundColor:"transparent",
              cursor:"pointer", userSelect:"none",
              letterSpacing:"0.03em",
            }}
          >Details</div>
```

Changes: text `[i]` -> `Details`, slightly more horizontal padding (`2px 5px` -> `3px 8px`), font size `11` -> `10` to keep it compact, added `letterSpacing` for readability.

---

## Checklist

- [ ] Update `width` in `SwitchDetailSlideIn.jsx` from `560` to `"75vw"` with `maxWidth: 1200`
- [ ] Replace `[i]` button text and styling in `SwitchPanel.jsx`
- [ ] Rebuild frontend and verify both changes visually
