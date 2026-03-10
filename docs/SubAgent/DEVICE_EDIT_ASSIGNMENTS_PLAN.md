# Device Edit Assignments - Implementation Plan

## Goal

Add an edit form to `DevicesTab.jsx` so that when a switch has been assigned a rack, class, or model (via the Racks, Classes, or Models tabs), the Devices/Switches tab reflects those assignments and allows editing them via a modal form.

**Scope:** Frontend-only changes in a single file: `frontend/src/components/settings/DevicesTab.jsx`.

---

## Reference Patterns

- **CredentialsTab.jsx** - Primary reference for fetching reference data (racks, classes, models) via `Promise.allSettled`, edit modal with select dropdowns, `startEdit`/`resetForm`/`submit` pattern.
- **RacksTab.jsx** - Reference for the "Edit" button styling per row (line 143): `<button onClick={() => startEdit(rack)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>`.
- **Backend** - `PATCH /api/topology/devices/{id}/meta` with `DeviceMetaUpdate` (accepts `sys_name`, `location`, `vendor`, `model`, `rack_id`, `class_id`, `model_id`, `ignored`). `GET /api/devices` returns `DeviceOut` which includes `rack_id`, `class_id`, `model_id`.

---

## Implementation Checklist

### Step 1: Add EMPTY_FORM constant

Add a form template constant above the component function for the edit modal fields.

```javascript
const EMPTY_DEVICE_FORM = {
  sys_name: "",
  location: "",
  vendor: "",
  model: "",
  rack_id: null,
  class_id: null,
  model_id: null,
};
```

Place this right after the imports, before `function DevicesTabContent()`.

---

### Step 2: Add new state variables

Inside `DevicesTabContent`, add state for reference data, modal control, form, and error.

Add after the existing `const [bulkLoading, setBulkLoading] = useState(false);` line:

```javascript
const [racks, setRacks]         = useState([]);
const [classes, setClasses]     = useState([]);
const [models, setModels]       = useState([]);
const [editState, setEditState] = useState({ id: null, open: false });
const [form, setForm]           = useState({ ...EMPTY_DEVICE_FORM });
const [err, setErr]             = useState("");
```

---

### Step 3: Update `refresh` to fetch reference data

Replace the current `refresh` function that only fetches `/api/devices` with one that uses `Promise.allSettled` to also fetch racks, classes, and models (same pattern as CredentialsTab).

**Replace:**
```javascript
const refresh = useCallback(() => {
  setLoading(true);
  api.get("/api/devices")
    .then(d => { setDevices(Array.isArray(d) ? d : []); setLoading(false); })
    .catch(() => { setDevices([]); setLoading(false); });
}, []);
```

**With:**
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

---

### Step 4: Add form helper functions

Add these after the `bulkIgnore` function and before the `INPUT_ROW` style constant:

```javascript
const resetForm = () => { setForm({ ...EMPTY_DEVICE_FORM }); setEditState({ id: null, open: false }); setErr(""); };

const startEdit = (dev) => {
  setForm({
    sys_name: dev.sys_name ?? "",
    location: dev.location ?? "",
    vendor: dev.vendor ?? "",
    model: dev.model ?? "",
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
    await api.patch(`/api/topology/devices/${editState.id}/meta`, form);
    api.invalidate("/api/topology", "/api/devices");
    resetForm();
    refresh();
  } catch (ex) { setErr(String(ex)); }
};

const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
```

Key details:
- `startEdit` populates the form from the device's current values (mirrors CredentialsTab pattern).
- `submitEdit` uses `PATCH /api/topology/devices/{id}/meta` (not PUT, since this is a partial update).
- After successful save, invalidates cache and refreshes the list.
- `set` is a shorthand for updating form fields (same as CredentialsTab).

---

### Step 5: Add assignment display in device rows

Inside the `renderDevice` function, add a line below the vendor/model display to show current rack, class, and model assignments as small badges.

After the existing vendor/model block:
```jsx
{dev.vendor && (
  <div style={{ color: "#475569", fontSize: 10, marginTop: 2 }}>
    {dev.vendor}{dev.model ? ` — ${dev.model}` : ""}
  </div>
)}
```

Add a new block to display assignments:
```jsx
{(dev.rack_id || dev.class_id || dev.model_id) && (
  <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
    {dev.rack_id && (() => { const r = racks.find(x => x.id === dev.rack_id); return r ? (
      <span style={{ color: "#a78bfa", fontSize: 9, backgroundColor: "#1e1045", padding: "1px 5px", borderRadius: 3, border: "1px solid #3b2070" }}>
        Rack: {r.label}
      </span>
    ) : null; })()}
    {dev.class_id && (() => { const c = classes.find(x => x.id === dev.class_id); return c ? (
      <span style={{ color: "#fbbf24", fontSize: 9, backgroundColor: "#1a1500", padding: "1px 5px", borderRadius: 3, border: "1px solid #4a3c00" }}>
        Class: {c.label}
      </span>
    ) : null; })()}
    {dev.model_id && (() => { const m = models.find(x => x.id === dev.model_id); return m ? (
      <span style={{ color: "#34d399", fontSize: 9, backgroundColor: "#042f1e", padding: "1px 5px", borderRadius: 3, border: "1px solid #065f3a" }}>
        Model: {m.name}
      </span>
    ) : null; })()}
  </div>
)}
```

This uses small colored badges (distinct colors per type: purple for rack, amber for class, green for model) to show assignment names resolved from their IDs using the fetched reference data.

---

### Step 6: Add Edit button to device rows

In `renderDevice`, add an Edit button before the existing Ignore/Re-enable button.

Before the existing ignore button (`<button disabled={isToggling}...`), add:
```jsx
<button
  onClick={() => startEdit(dev)}
  style={{
    flexShrink: 0,
    background: "none",
    border: "1px solid #1e293b",
    color: "#64748b",
    borderRadius: 5,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 10,
    fontWeight: 600,
  }}
>Edit</button>
```

This follows the exact same button style from RacksTab.jsx line 143.

---

### Step 7: Add edit modal JSX

Add the modal overlay in the return JSX, right after the opening `<div>` of the return statement and before the description text. This follows the same placement pattern as CredentialsTab and RacksTab.

Insert before the `<div style={{ color: "#475569", fontSize: 11 }}>` line:

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
      width: 480, maxHeight: "calc(100vh - 80px)", overflowY: "auto",
      backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 12,
      padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ color: "#94a3b8", fontSize: 10, letterSpacing: 1 }}>EDIT DEVICE</div>
        <button type="button" onClick={resetForm} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>{"\u2715"}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>System Name
          <input value={form.sys_name} onChange={e => set("sys_name", e.target.value)} placeholder="e.g. Core-SW-01" style={{ ...inp, marginTop: 3 }} />
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Location
          <input value={form.location} onChange={e => set("location", e.target.value)} placeholder="e.g. RZ-01" style={{ ...inp, marginTop: 3 }} />
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Vendor
          <input value={form.vendor} onChange={e => set("vendor", e.target.value)} placeholder="e.g. Aruba" style={{ ...inp, marginTop: 3 }} />
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Model
          <input value={form.model} onChange={e => set("model", e.target.value)} placeholder="e.g. 6300M" style={{ ...inp, marginTop: 3 }} />
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Rack
          <select value={form.rack_id ?? ""} onChange={e => set("rack_id", e.target.value ? +e.target.value : null)} style={{ ...sel, marginTop: 3 }}>
            <option value="">-- No rack --</option>
            {racks.map(r => <option key={r.id} value={r.id}>{r.label}{r.room ? ` / ${r.room}` : ""}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Class
          <select value={form.class_id ?? ""} onChange={e => set("class_id", e.target.value ? +e.target.value : null)} style={{ ...sel, marginTop: 3 }}>
            <option value="">-- No class --</option>
            {classes.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Switch Model
          <select value={form.model_id ?? ""} onChange={e => set("model_id", e.target.value ? +e.target.value : null)} style={{ ...sel, marginTop: 3 }}>
            <option value="">-- No switch model --</option>
            {[...models].sort((a, b) => a.name.localeCompare(b.name)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      {err && <div style={{ marginBottom: 8, color: "#f87171", fontSize: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={{ flex: 1, backgroundColor: "#083344", border: "1px solid #164e63", color: "#22d3ee", borderRadius: 6, padding: "8px", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600 }}>
          Save changes
        </button>
        <button type="button" onClick={resetForm} style={{ border: "1px solid #1e293b", background: "none", color: "#64748b", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>
          Cancel
        </button>
      </div>
    </form>
  </div>
)}
```

Note: The `inp` and `sel` style objects must be defined. Add them just before the `INPUT_ROW` constant (or alongside it):

```javascript
const inp = {
  backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
  color: "#e2e8f0", padding: "5px 8px",
  fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
  boxSizing: "border-box", width: "100%",
};
const sel = { ...inp, cursor: "pointer" };
```

These follow the exact same style definitions from CredentialsTab.

---

## Summary of All Changes (single file)

**File:** `frontend/src/components/settings/DevicesTab.jsx`

| # | Change | Lines Affected |
|---|--------|---------------|
| 1 | Add `EMPTY_DEVICE_FORM` constant | Before component function |
| 2 | Add state: `racks`, `classes`, `models`, `editState`, `form`, `err` | After existing state declarations |
| 3 | Update `refresh` to use `Promise.allSettled` with 4 endpoints | Replace existing `refresh` |
| 4 | Add `resetForm`, `startEdit`, `submitEdit`, `set` functions | After `bulkIgnore` |
| 5 | Add `inp`, `sel` style objects | Alongside `INPUT_ROW` |
| 6 | Add assignment badges in `renderDevice` | After vendor/model display |
| 7 | Add Edit button in `renderDevice` | Before Ignore button |
| 8 | Add edit modal overlay in JSX | Top of return block |

**No backend changes required.** The `GET /api/devices` already returns `rack_id`, `class_id`, `model_id` and the `PATCH /api/topology/devices/{id}/meta` endpoint already accepts all fields.
