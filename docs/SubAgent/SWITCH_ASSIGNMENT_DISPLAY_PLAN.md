# Switch Assignment Display - Implementation Plan

## Goal

Add edit form and assignment display to the DevicesTab so users can view and edit rack, class, and model assignments for each device directly from the Devices tab.

## Scope

- **Single file change:** `frontend/src/components/settings/DevicesTab.jsx`
- **No backend changes required** -- all endpoints and schemas already support this.

## Reference Patterns

- **CredentialsTab.jsx** -- `Promise.allSettled` multi-fetch, `editState`/`form`/`err` state, `startEdit`, `submit`, modal overlay with `<select>` dropdowns for rack/class.
- **RacksTab.jsx** -- simpler modal pattern with `resetForm`, `startEdit`, `submit`, inline styles.
- **Existing DevicesTab.jsx** -- already uses `api.patch(/api/topology/devices/${id}/meta, ...)` for ignore toggle; same endpoint accepts `rack_id`, `class_id`, `model_id`.

---

## Step-by-Step Implementation

### Step 1: Add new state variables

Add the following state declarations after the existing ones (after `bulkLoading`):

```javascript
const [racks, setRacks]           = useState([]);
const [classes, setClasses]       = useState([]);
const [models, setModels]         = useState([]);
const [editState, setEditState]   = useState({ id: null, open: false });
const [form, setForm]             = useState({ rack_id: null, class_id: null, model_id: null });
const [err, setErr]               = useState("");
```

- `racks`, `classes`, `models` -- reference data for dropdown population.
- `editState` -- tracks which device is being edited and whether the modal is open. Pattern matches CredentialsTab/RacksTab.
- `form` -- holds the current edit form values (only the three assignment fields).
- `err` -- error string displayed in the modal.

### Step 2: Update `refresh` to fetch reference data

Replace the current `refresh` function with a `Promise.allSettled` call that fetches all four data sources simultaneously:

```javascript
const refresh = useCallback(() => {
  setLoading(true);
  Promise.allSettled([
    api.get("/api/devices"),
    api.get("/api/racks"),
    api.get("/api/switch-classes"),
    api.get("/api/switch-models"),
  ]).then(([devRes, racksRes, classesRes, modelsRes]) => {
    setDevices(devRes.status === "fulfilled" && Array.isArray(devRes.value) ? devRes.value : []);
    setRacks(racksRes.status === "fulfilled" ? racksRes.value || [] : []);
    setClasses(classesRes.status === "fulfilled" ? classesRes.value || [] : []);
    setModels(modelsRes.status === "fulfilled" ? modelsRes.value || [] : []);
    setLoading(false);
  });
}, []);
```

Endpoints used:
| Endpoint | State | Notes |
|---|---|---|
| `GET /api/devices` | `devices` | Already used; returns `rack_id`, `class_id`, `model_id` per device |
| `GET /api/racks` | `racks` | Returns `[{ id, label, room, ... }]` |
| `GET /api/switch-classes` | `classes` | Returns `[{ id, label, color, ... }]` |
| `GET /api/switch-models` | `models` | Returns `[{ id, name, ... }]` |

### Step 3: Add form helper functions

Add these functions after the existing `bulkIgnore` function:

```javascript
const resetForm = () => {
  setForm({ rack_id: null, class_id: null, model_id: null });
  setEditState({ id: null, open: false });
  setErr("");
};

const startEdit = (dev) => {
  setForm({
    rack_id: dev.rack_id ?? null,
    class_id: dev.class_id ?? null,
    model_id: dev.model_id ?? null,
  });
  setEditState({ id: dev.id, open: true });
  setErr("");
};

const submitEdit = async (e) => {
  e.preventDefault();
  setErr("");
  try {
    await api.patch(`/api/topology/devices/${editState.id}/meta`, {
      rack_id: form.rack_id,
      class_id: form.class_id,
      model_id: form.model_id,
    });
    api.invalidate("/api/topology", "/api/devices");
    resetForm();
    refresh();
  } catch (ex) {
    setErr(String(ex));
  }
};
```

Key design decisions:
- `startEdit` populates form with current device assignments using `?? null` to handle missing values.
- `submitEdit` sends all three fields to `PATCH /api/topology/devices/{id}/meta`. The backend uses `exclude_unset=True` but since we always set all three fields, it will update all three. This is correct because the user sees all three in the form and can clear any of them.
- `api.invalidate` clears both `/api/topology` and `/api/devices` caches so other tabs see updated assignments.
- On success, `resetForm` closes the modal and `refresh` reloads data.

### Step 4: Add helper maps for display lookups

Add lookup maps (after the state but before or within the render logic) to efficiently resolve IDs to display labels:

```javascript
const rackMap  = Object.fromEntries(racks.map(r => [r.id, r]));
const classMap = Object.fromEntries(classes.map(c => [c.id, c]));
const modelMap = Object.fromEntries(models.map(m => [m.id, m]));
```

These will be used in:
- The device list rows to show assignment badges.
- Derived from state on each render (lightweight, no extra state needed).

### Step 5: Add assignment badges to device list rows

Inside the `renderDevice` function, after the existing ignored badge and after the port count badge, add assignment badges that show the current rack, class, and model for each device:

```jsx
{dev.rack_id && rackMap[dev.rack_id] && (
  <span style={{
    color: "#a78bfa", fontSize: 10,
    backgroundColor: "#1e1035", padding: "1px 5px",
    borderRadius: 3, border: "1px solid #3b1f7e"
  }}>
    {rackMap[dev.rack_id].label}
  </span>
)}
{dev.class_id && classMap[dev.class_id] && (
  <span style={{
    color: classMap[dev.class_id].color || "#38bdf8", fontSize: 10,
    backgroundColor: "#0c1a2e", padding: "1px 5px",
    borderRadius: 3, border: `1px solid ${classMap[dev.class_id].color || "#1e3a5f"}`
  }}>
    {classMap[dev.class_id].label}
  </span>
)}
{dev.model_id && modelMap[dev.model_id] && (
  <span style={{
    color: "#fbbf24", fontSize: 10,
    backgroundColor: "#1a1500", padding: "1px 5px",
    borderRadius: 3, border: "1px solid #854d0e"
  }}>
    {modelMap[dev.model_id].name}
  </span>
)}
```

Badge color scheme:
- Rack: purple tones (`#a78bfa`)
- Class: uses the class's own `color` property (or fallback blue)
- Model: amber/gold tones (`#fbbf24`)

These are placed in the same flex row as existing badges (ports, ignored), so they flow naturally.

### Step 6: Add Edit button to each device row

In the `renderDevice` function, add an Edit button next to the existing Ignore/Re-enable button:

```jsx
<button
  onClick={() => startEdit(dev)}
  style={{
    flexShrink: 0,
    backgroundColor: "#0c1a2e",
    border: "1px solid #1e3a5f",
    color: "#7dd3fc",
    borderRadius: 5,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 10,
    fontWeight: 600,
  }}
>
  Edit
</button>
```

Place this button **before** the existing Ignore/Re-enable button so the action order is: Edit | Ignore.

### Step 7: Add the edit modal overlay

Add modal JSX right after the help text `<div>` and before the bulk action toolbar in the return JSX. Follow the exact same modal pattern as CredentialsTab/RacksTab:

```jsx
{editState.open && (
  <div
    onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
    style={{
      position: "fixed", inset: 0, zIndex: 200,
      backgroundColor: "rgba(2,8,23,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
  >
    <form onSubmit={submitEdit} style={{
      width: 420, maxHeight: "calc(100vh - 80px)", overflowY: "auto",
      backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 12,
      padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ color: "#94a3b8", fontSize: 10, letterSpacing: 1 }}>EDIT DEVICE</div>
        <button type="button" onClick={resetForm}
          style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>
          &#x2715;
        </button>
      </div>

      {/* Device identity (read-only info) */}
      <div style={{ marginBottom: 12, padding: "8px 10px", backgroundColor: "#0c0f18", borderRadius: 6, border: "1px solid #1e293b" }}>
        <div style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600 }}>
          {(() => { const d = devices.find(d => d.id === editState.id); return d ? (d.sys_name || d.ip) : ""; })()}
        </div>
        <div style={{ color: "#475569", fontSize: 10 }}>
          {(() => { const d = devices.find(d => d.id === editState.id); return d?.ip || ""; })()}
        </div>
      </div>

      {/* Assignment dropdowns */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
          Rack
          <select
            value={form.rack_id ?? ""}
            onChange={e => setForm(p => ({ ...p, rack_id: e.target.value ? +e.target.value : null }))}
            style={{ ...sel, marginTop: 3 }}
          >
            <option value="">-- No rack --</option>
            {racks.map(r => (
              <option key={r.id} value={r.id}>{r.label}{r.room ? ` / ${r.room}` : ""}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
          Class
          <select
            value={form.class_id ?? ""}
            onChange={e => setForm(p => ({ ...p, class_id: e.target.value ? +e.target.value : null }))}
            style={{ ...sel, marginTop: 3 }}
          >
            <option value="">-- No class --</option>
            {classes.map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
          Model
          <select
            value={form.model_id ?? ""}
            onChange={e => setForm(p => ({ ...p, model_id: e.target.value ? +e.target.value : null }))}
            style={{ ...sel, marginTop: 3 }}
          >
            <option value="">-- No model --</option>
            {[...models].sort((a, b) => a.name.localeCompare(b.name)).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
      </div>

      {err && <div style={{ color: "#f87171", fontSize: 11, marginBottom: 8 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={resetForm}
          style={{ background: "none", border: "1px solid #1e293b", color: "#64748b", borderRadius: 5, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11 }}>
          Cancel
        </button>
        <button type="submit"
          style={{ backgroundColor: "#164e63", border: "1px solid #22d3ee", color: "#22d3ee", borderRadius: 5, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600 }}>
          Save
        </button>
      </div>
    </form>
  </div>
)}
```

The modal includes:
- Click-outside-to-close (backdrop `onClick` with `e.target === e.currentTarget` check).
- Close button (X) in the header.
- Read-only device identity section showing the device name and IP.
- Three `<select>` dropdowns for Rack, Class, and Model -- each with a "none" option.
- Error display area.
- Cancel and Save buttons.

### Step 8: Add style constants for the form

Add these style constants alongside the existing `INPUT_ROW` constant:

```javascript
const sel = {
  backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
  color: "#e2e8f0", padding: "5px 8px",
  fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
  boxSizing: "border-box", width: "100%", cursor: "pointer",
};
```

This matches the `sel` style object used in CredentialsTab and RacksTab.

---

## Implementation Checklist

- [ ] 1. Add state variables: `racks`, `classes`, `models`, `editState`, `form`, `err`
- [ ] 2. Update `refresh()` to use `Promise.allSettled` fetching devices + racks + classes + models
- [ ] 3. Add `resetForm()` function
- [ ] 4. Add `startEdit(dev)` function
- [ ] 5. Add `submitEdit(e)` handler
- [ ] 6. Add lookup maps: `rackMap`, `classMap`, `modelMap`
- [ ] 7. Add `sel` style constant for select dropdowns
- [ ] 8. Add assignment badges (rack, class, model) in `renderDevice` device row
- [ ] 9. Add Edit button in `renderDevice` device row (before Ignore button)
- [ ] 10. Add edit modal overlay JSX with three dropdowns, read-only device info, error display, Cancel/Save buttons

---

## Files Modified

| File | Change Type | Description |
|---|---|---|
| `frontend/src/components/settings/DevicesTab.jsx` | Modified | Add edit form, assignment display, reference data fetching |

## No Backend Changes

The backend already provides everything needed:
- `GET /api/devices` returns `rack_id`, `class_id`, `model_id` per device
- `GET /api/racks`, `GET /api/switch-classes`, `GET /api/switch-models` return reference lists
- `PATCH /api/topology/devices/{id}/meta` accepts `rack_id`, `class_id`, `model_id` via `DeviceMetaUpdate`

## Risk Assessment

- **Low risk.** All changes are additive to one frontend file. Existing functionality (ignore/re-enable, bulk actions, checkbox selection) is untouched.
- The same PATCH endpoint and pattern already works in RacksTab, ClassesTab, ModelsTab, and CredentialsTab.
- Cache invalidation pattern (`api.invalidate("/api/topology", "/api/devices")`) matches existing usage in the same file.
