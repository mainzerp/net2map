# Settings Tabs UI Pattern Analysis

## Tab Registration (SettingsPage.jsx)

### Nav Groups and Tab-Component Mapping

| activeTab | Nav Label | Nav Description | Rendered Component |
|-----------|-----------|-----------------|-------------------|
| `"switches"` | Switches | Credentials | `CredentialsTabContent` |
| `"racks"` | Racks | Rack definitions | `RacksTabContent` |
| `"classes"` | Classes | Device roles / classes | `ClassesTabContent` |
| `"models"` | Models | Switch models & port layout | `ModelsTabContent` |
| `"devices"` | *(not in nav)* | *(no nav entry)* | `DevicesTabContent` |

**Key observations:**
- `DevicesTabContent` is imported and rendered for `activeTab === "devices"` but has NO entry in `NAV_GROUPS` -- it is inaccessible from the sidebar nav.
- The "Switches" tab (`activeTab === "switches"`) actually renders `CredentialsTabContent`, not `DevicesTabContent`.
- The SettingsPage header area has a **`+ New Entry`** button that appears ONLY when `activeTab === "switches"`:
  ```jsx
  {activeTab === "switches" && (
    <button onClick={() => setNewEntryTrigger(t => t + 1)} ...>+ New Entry</button>
  )}
  ```
  This button does NOT exist for racks, classes, or models tabs.

### Content Area Layout (SettingsPage)
- Container: `padding: "0 32px 20px"`, `flex: 1`, `overflow: hidden`, `display: flex`
- Header section: `padding: "20px 32px 0"`, includes tab title, description, and optional action button
- Separator: `height: 1, backgroundColor: "#0f172a", marginTop: 14`

---

## 1. DevicesTab.jsx (THE REFERENCE)

### Purpose
Read-only device listing with ignore/re-enable and bulk actions. **Has NO create/edit form** -- this is a list-only viewer for discovered devices.

### Structure

#### New Entry Form
**None.** Devices are discovered by the scan engine, not manually created.

#### Edit Form
**None.** No editing capability -- only toggle ignore/re-enable per device.

#### Layout
```
Container: flex column, gap: 16, overflowY: auto, paddingTop: 20, flex: 1
  -> Description text
  -> [Conditional] Bulk action toolbar (when items selected)
  -> Active Devices card (rounded card with header + list)
  -> [Conditional] Ignored Devices card (rounded card with header + list)
```

#### List Item Rendering (`INPUT_ROW` style)
Each device row:
```
display: flex, alignItems: center, gap: 10,
padding: "8px 12px",
borderBottom: "1px solid #0f172a"
```
- Checkbox (accent: #22d3ee)
- Device info (flex:1): name, IP, port badge, ignored badge, vendor/model
- Action button: "Ignore" / "Re-enable" (single-action inline button)

#### Section Card Styling
```
backgroundColor: "#0a0e18",
border: "1px solid #1e293b",   // active devices
border: "1px solid #3f1515",   // ignored devices
borderRadius: 8,
overflow: hidden
```

#### Section Header
```
padding: "8px 12px",
borderBottom: "1px solid #0f172a",
color: "#94a3b8",
fontSize: 10, fontWeight: 700, letterSpacing: 1,
display: flex, alignItems: center, justifyContent: space-between
```
Format: `ACTIVE DEVICES (N)` with "Select All" button.

#### Bulk Action Toolbar
```
display: flex, alignItems: center, gap: 8,
padding: "8px 12px",
backgroundColor: "#0c1a2e",
border: "1px solid #1e3a5f",
borderRadius: 8
```
Contains: count label, "Ignore Selected", "Re-enable Selected", "Clear" buttons.

#### State Management
- `devices` -- array of device objects
- `loading` -- boolean
- `togglingId` -- ID of device currently being toggled
- `selected` -- Set of selected device IDs
- `bulkLoading` -- boolean for bulk operations

#### Button Styles
- Ignore button: `bg: #1a0a0a, border: 1px solid #7f1d1d, color: #f87171`
- Re-enable button: `bg: #083344, border: 1px solid #164e63, color: #22d3ee`
- Clear button: `bg: none, border: 1px solid #1e293b, color: #64748b`

---

## 2. CredentialsTab.jsx (Switches tab)

### Purpose
Full CRUD for switch credential entries. Uses **modal overlay** for new/edit and a **card grid** for listing.

### Structure

#### New Entry Form -- MODAL OVERLAY
Triggered by `newEntryTrigger` prop from SettingsPage header button.

```jsx
<div onClick={backdrop close} style={{
  position: "fixed", inset: 0, zIndex: 200,
  backgroundColor: "rgba(2,8,23,0.75)",
  display: "flex", alignItems: "center", justifyContent: "center",
}}>
  <form style={{
    width: 560, maxHeight: "calc(100vh - 80px)", overflowY: "auto",
    backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 12,
    padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
  }}>
```

**Modal header:**
```
display: flex, alignItems: center, justifyContent: space-between, marginBottom: 14
```
- Title: `color: "#94a3b8", fontSize: 10, letterSpacing: 1` -- shows "EDIT ENTRY" or "NEW ENTRY"
- Close button: `x` character, `background: none, border: none, color: #475569, fontSize: 16`

**Form layout:** 2-column grid `gridTemplateColumns: "1fr 1fr", gap: 8`

**Input styling:**
```
backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
color: "#e2e8f0", padding: "5px 8px",
fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
boxSizing: "border-box", width: "100%"
```

**Label styling:**
```
fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none"
```

**Submit buttons (modal footer):**
```
display: flex, gap: 8
```
- Submit: `flex: 1, bg: #083344, border: 1px solid #164e63, color: #22d3ee, borderRadius: 6, padding: 8px`
- Cancel: `border: 1px solid #1e293b, bg: none, color: #64748b, borderRadius: 6, padding: 8px 16px`

#### Edit Form
Same modal overlay. `editState.id` is set, form is pre-populated with `startEdit(c)`.

#### List Layout -- CARD GRID
```
display: grid,
gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
gap: 8
```

Each card:
```
display: flex, flexDirection: column,
padding: "10px 12px",
backgroundColor: "#0a0e18",
border: "1px solid #1e293b" (enabled) / "#0f172a" (disabled),
borderRadius: 8,
opacity: 1 (enabled) / 0.5 (disabled)
```

Card content:
- Status dot (6px circle, green #22c55e or gray #64748b)
- Label (bold, 12px)
- Version badge (v2c/v3)
- Rack badge
- Discovery status badge
- IP + details line

Card action buttons (bottom-right): Edit, Delete (with confirm), Ignore toggle

#### "Discovered Without Credentials" Section
Same grid layout, different badge colors (yellow #eab308 theme), `+ Add credentials` button.

#### State Management
```javascript
editState = { id: null, open: false }   // controls modal open/close and create vs edit
form = { ...EMPTY_FORM }               // form data
err = ""                                // error string
confirmDeleteId = null                  // inline delete confirmation
togglingIgnoreId = null                 // ignore toggle in-progress
```

- `startNew()` -- opens modal with empty form (`editState: { id: null, open: true }`)
- `startEdit(c)` -- opens modal with populated form (`editState: { id: c.id, open: true }`)
- `resetForm()` -- closes modal, clears form

#### Form Submission
```javascript
const submit = async (e) => {
  e.preventDefault(); setErr("");
  if (editState.id) { await api.put(`/api/credentials/${editState.id}`, form); }
  else { const r = await api.post("/api/credentials", form); }
  resetForm(); refresh();
};
```

---

## 3. RacksTab.jsx

### Purpose
CRUD for rack definitions with device assignment functionality.

### Structure

#### New Entry Form -- INLINE (always visible at top)
```jsx
<form style={{
  backgroundColor: "#0a0e18",
  border: "1px solid #1e293b",
  borderRadius: 8,
  padding: 14,
  display: "flex", flexDirection: "column", gap: 8
}}>
```
No modal. The form is always rendered at the top of the tab content.

**Form header:**
```
color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 4
```
Shows `"EDIT RACK"` or `"NEW RACK"`.

**Fields layout:** Vertical stack (single column), each in its own `<div>`.

**Input styling:**
```
width: "100%", backgroundColor: "#020817", border: "1px solid #1e293b",
borderRadius: 4, padding: "5px 8px", color: "#e2e8f0",
fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, boxSizing: "border-box"
```
NOTE: bg is `#020817` vs CredentialsTab's `#0c0f18`, borderRadius is `4` vs `5`.

**Label styling:**
```
color: "#94a3b8", fontSize: 10, marginBottom: 3, display: "block"
```

**Submit buttons:**
```
display: flex, gap: 6
```
- Submit: `flex: 1, bg: #083344, border: 1px solid #164e63, color: #22d3ee, borderRadius: 6, padding: 6px, fontSize: 11, fontWeight: 600`
- Cancel (edit only): `bg: transparent, border: 1px solid #1e293b, color: #64748b, borderRadius: 6, padding: 6px 12px`

#### Edit Form
**Same inline form at top.** `startEdit(r)` populates the form and sets `editId`. The form header changes to "EDIT RACK".

#### List Layout -- VERTICAL STACK
Below the form, rendered with `racks.map(...)`. No grid, just stacked `<div>` cards.

Each card:
```
backgroundColor: "#0a0e18",
border: "1px solid #1e293b",
borderRadius: 8,
padding: "12px 14px"
```

Card content:
- Flex row: Label (bold, 13px) + Edit/Delete buttons (right side)
- Subtitle: room - description
- Separator: `borderTop: 1px solid #0f172a, paddingTop: 8, marginTop: 10`
- "ASSIGNED SWITCHES (N)" section with chip-style device tokens
- Device assignment dropdown + "Assign" button

#### Action Buttons on Cards
- Edit: `bg: none, border: 1px solid #1e293b, color: #64748b, borderRadius: 4, padding: 2px 8px, fontSize: 10`
- Delete: `bg: none, border: 1px solid #7f1d1d, color: #f87171, borderRadius: 4, padding: 2px 8px, fontSize: 10`
- Delete Confirm: `bg: #450a0a, border: 1px solid #7f1d1d, color: #fca5a5`

#### State Management
```javascript
editId = null          // null = new mode, number = editing
form = { ...EMPTY_RACK_FORM }
err = ""
confirmDeleteId = null
assignSel = {}         // per-rack device assignment selection
```

- `resetForm()` -- clears form, sets editId to null
- `startEdit(r)` -- sets editId, populates form

#### Form Submission
```javascript
if (editId) { await api.put(`/api/racks/${editId}`, form); }
else { const r = await api.post("/api/racks", form); }
resetForm(); refreshAll();
```

---

## 4. SwitchClassesTab.jsx

### Purpose
CRUD for device classes/roles with device assignment. Nearly identical pattern to RacksTab.

### Structure

#### New Entry Form -- INLINE (always visible at top)
Same card/form as Racks:
```
backgroundColor: "#0a0e18", border: "1px solid #1e293b",
borderRadius: 8, padding: 14, display: flex, flexDirection: column, gap: 8
```

**Fields layout:** Mix of flex row (Label + Color picker side by side) and vertical stack.
- Label: text input (flex: 1)
- Color: color input (40x29px)
- Description: text input
- "Allow outside rack" checkbox
- Submit/Cancel buttons

#### Edit Form
Same inline form. startEdit populates `editId` + `form`.

#### List Layout -- VERTICAL STACK
Same as Racks, but each card has:
- Color accent bar: `position: absolute, top: 0, left: 0, width: 3, bottom: 0, backgroundColor: sc.color`
- Content shifted: `marginLeft: 12`
- Color dot: 9px circle next to label
- "Outside allowed" / "Rack required" badge
- ASSIGNED SWITCHES section
- Device assignment dropdown

#### State Management
Same as Racks: `editId`, `form`, `err`, `confirmDeleteId`, `assignSel`.

#### Key Differences from RacksTab
- Has a color picker field
- Has color accent bar on list cards
- Has "allow_outside_rack" checkbox field
- Card border uses `${sc.color}44` (translucent class color)

---

## 5. SwitchModelsTab.jsx

### Purpose
CRUD for switch models (port layout configuration) with device assignment. Same pattern as RacksTab/ClassesTab.

### Structure

#### New Entry Form -- INLINE (always visible at top)
Same card/form structure.

**Fields layout:** Flex row with multiple columns:
- Name (flex: 2)
- Ports per row (flex: 1, number input)
- Total ports / cutoff (flex: 1, with toggle switch)
- Description (separate row)

Has a custom toggle switch widget for the cutoff feature:
```
width: 32, height: 18, borderRadius: 9
backgroundColor: cutoffEnabled ? "#0e7490" : "#1e293b"
```

#### Edit Form
Same inline form. startEdit populates form + sets `cutoffEnabled` based on existing data.

#### List Layout -- VERTICAL STACK
Same as ClassesTab pattern:
- Cyan accent bar (hardcoded `#22d3ee`)
- Content shifted `marginLeft: 12`
- Name + port count badge + total ports info
- ASSIGNED SWITCHES section
- Device assignment dropdown

#### State Management
Same base: `editId`, `form`, `err`, `confirmDeleteId`, `assignSel`.
Extra: `cutoffEnabled` boolean for the toggle switch.

---

## Pattern Comparison Summary

| Feature | CredentialsTab | RacksTab | ClassesTab | ModelsTab | DevicesTab |
|---------|---------------|----------|------------|-----------|------------|
| **New Entry** | Modal overlay | Inline form (top) | Inline form (top) | Inline form (top) | None |
| **Edit** | Modal overlay | Same inline form | Same inline form | Same inline form | None |
| **Trigger mechanism** | `newEntryTrigger` prop from parent + header button | Always visible, user fills and submits | Same as Racks | Same as Racks | N/A |
| **List layout** | Card grid (auto-fill, 300px min) | Vertical stack | Vertical stack | Vertical stack | Sectioned list (active/ignored) |
| **Form location** | Fixed modal with backdrop | Top of content area | Top of content area | Top of content area | N/A |
| **Edit/New distinction** | `editState.open` boolean + `editState.id` | `editId` (null=new) | `editId` (null=new) | `editId` (null=new) | N/A |
| **Form header** | "NEW ENTRY" / "EDIT ENTRY" | "NEW RACK" / "EDIT RACK" | "NEW CLASS" / "EDIT CLASS" | "NEW MODEL" / "EDIT MODEL" | N/A |
| **Delete confirm** | Inline button swap | Inline button swap | Inline button swap | Inline button swap | N/A |
| **Device assignment** | N/A (IS the device entry) | Dropdown per rack | Dropdown per class | Dropdown per model | N/A |
| **Header action button** | "+ New Entry" in SettingsPage | None | None | None | None |

---

## Critical Findings: What the User Likely Wants

### Important Naming Clarification
The user stated `DevicesTab.jsx` is "the switches tab" with the desired pattern. However:
- **`DevicesTab.jsx`** has NO create/edit form. It is a pure listing component with checkboxes and ignore/re-enable buttons.
- The "Switches" tab (`activeTab === "switches"`) renders **`CredentialsTabContent`**, which has the modal-based create/edit pattern with a `+ New Entry` header button.

### The "Desired Pattern" is most likely the CredentialsTab pattern:
1. **`+ New Entry` button** in the SettingsPage header (not inside the tab component)
2. **Modal overlay** for both create and edit (position:fixed, centered, with backdrop)
3. **Card grid** for listing items (not vertical stack)
4. **Two-column form layout** inside the modal (gridTemplateColumns: "1fr 1fr")
5. **Modal state management** via `editState = { id, open }` pattern
6. **`newEntryTrigger` prop** passed from parent to open the new entry modal

### What Currently Differs (RacksTab, ClassesTab, ModelsTab):
1. **No `+ New Entry` header button** -- these tabs have no header action button in SettingsPage
2. **Inline form always visible** at the top instead of a modal overlay
3. **Vertical stack listing** instead of card grid
4. **`editId` state** (simple ID or null) instead of `editState = { id, open }` pattern
5. **Form fields are single-column** (mostly) instead of two-column grid
6. **No backdrop dismiss** capability
7. **Input bg color differs**: `#020817` (Racks/Classes/Models) vs `#0c0f18` (Credentials)
8. **Input borderRadius differs**: `4` (Racks/Classes/Models) vs `5` (Credentials)

### To Unify the Pattern, Each Tab Needs:
1. Accept a `newEntryTrigger` prop and react to it
2. Replace the inline form with a modal overlay (position:fixed, backdrop, centered form)
3. Change to `editState = { id, open }` pattern
4. Convert listing to card grid: `gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))"`
5. SettingsPage needs `+ New Entry` buttons for racks, classes, and models tabs
6. Unify input styling to match Credentials: bg `#0c0f18`, borderRadius `5`

### Alternatively, if DevicesTab is Truly the Reference:
The DevicesTab pattern would mean:
- Remove create/edit forms entirely
- Show a flat list with bulk actions
- Checkboxes for multi-select
- This does NOT make sense for Racks/Classes/Models which require CRUD

### SettingsPage Changes Required
The SettingsPage currently only renders the `+ New Entry` button for the "switches" tab. To apply the same pattern to racks, classes, and models, SettingsPage needs:
```jsx
{(activeTab === "switches" || activeTab === "racks" || activeTab === "classes" || activeTab === "models") && (
  <button onClick={() => setNewEntryTrigger(t => t + 1)} ...>+ New Entry</button>
)}
```
Plus `newEntryTrigger` must be passed as a prop to all four tab components.

---

## Shared Style Constants Reference (from CredentialsTab)

### Modal Overlay
```javascript
position: "fixed", inset: 0, zIndex: 200,
backgroundColor: "rgba(2,8,23,0.75)",
display: "flex", alignItems: "center", justifyContent: "center"
```

### Modal Form Container
```javascript
width: 560, maxHeight: "calc(100vh - 80px)", overflowY: "auto",
backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 12,
padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.6)"
```

### Input Field
```javascript
backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
color: "#e2e8f0", padding: "5px 8px",
fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
boxSizing: "border-box", width: "100%"
```

### Label
```javascript
fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none"
```

### Primary Button
```javascript
backgroundColor: "#083344", border: "1px solid #164e63", color: "#22d3ee",
borderRadius: 6, padding: "8px", cursor: "pointer",
fontFamily: "inherit", fontSize: 11, fontWeight: 600
```

### Cancel Button
```javascript
border: "1px solid #1e293b", background: "none", color: "#64748b",
borderRadius: 6, padding: "8px 16px", cursor: "pointer",
fontFamily: "inherit", fontSize: 11
```

### Card Grid
```javascript
display: "grid",
gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
gap: 8
```

### List Item Card
```javascript
display: "flex", flexDirection: "column",
padding: "10px 12px",
backgroundColor: "#0a0e18",
border: "1px solid #1e293b",
borderRadius: 8
```

### Edit/Delete Inline Buttons
```javascript
// Edit
background: "none", border: "1px solid #1e293b", color: "#64748b",
borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 10

// Delete
background: "none", border: "1px solid #7f1d1d", color: "#f87171",
borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 10

// Delete Confirm
background: "#450a0a", border: "1px solid #7f1d1d", color: "#fca5a5",
borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 10
```

---

## Files Analyzed

| File | Lines | Component Export |
|------|-------|-----------------|
| `frontend/src/components/settings/DevicesTab.jsx` | 213 | `DevicesTabContent` |
| `frontend/src/components/settings/CredentialsTab.jsx` | 470 | `CredentialsTabContent` |
| `frontend/src/components/settings/RacksTab.jsx` | 154 | `RacksTabContent` |
| `frontend/src/components/settings/SwitchClassesTab.jsx` | ~230 | `ClassesTabContent` |
| `frontend/src/components/settings/SwitchModelsTab.jsx` | ~230 | `ModelsTabContent` |
| `frontend/src/pages/SettingsPage.jsx` | ~230 | `SettingsPage` |
