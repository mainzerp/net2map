# Settings Tabs UI Conversion Plan

Convert RacksTab, SwitchClassesTab, and SwitchModelsTab to use the same UI pattern as CredentialsTab: modal overlay for create/edit, card grid listing, and `+ New Entry` header button.

---

## File Checklist

- [ ] `frontend/src/pages/SettingsPage.jsx`
- [ ] `frontend/src/components/settings/RacksTab.jsx`
- [ ] `frontend/src/components/settings/SwitchClassesTab.jsx`
- [ ] `frontend/src/components/settings/SwitchModelsTab.jsx`

---

## Step 1: SettingsPage.jsx

### 1a. Expand `+ New Entry` button visibility

**Before (line ~178):**
```jsx
{activeTab === "switches" && (
  <button
    onClick={() => setNewEntryTrigger(t => t + 1)}
    style={{
      backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee",
      borderRadius:6, padding:"7px 16px", cursor:"pointer",
      fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
    }}
  >+ New Entry</button>
)}
```

**After:**
```jsx
{["switches","racks","classes","models"].includes(activeTab) && (
  <button
    onClick={() => setNewEntryTrigger(t => t + 1)}
    style={{
      backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee",
      borderRadius:6, padding:"7px 16px", cursor:"pointer",
      fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
    }}
  >+ New Entry</button>
)}
```

### 1b. Pass `newEntryTrigger` prop to all three tab components

**Before (lines ~203-206):**
```jsx
{activeTab === "racks"    && <RacksTabContent />}
{activeTab === "classes"  && <ClassesTabContent />}
{activeTab === "models"   && <ModelsTabContent />}
```

**After:**
```jsx
{activeTab === "racks"    && <RacksTabContent newEntryTrigger={newEntryTrigger} />}
{activeTab === "classes"  && <ClassesTabContent newEntryTrigger={newEntryTrigger} />}
{activeTab === "models"   && <ModelsTabContent newEntryTrigger={newEntryTrigger} />}
```

### 1c. Reset `newEntryTrigger` on tab change

Add a `useEffect` to reset the trigger counter when switching tabs, preventing stale triggers from opening modals in newly-activated tabs.

**Add after line ~20 (after the `newEntryTrigger` state declaration):**
```jsx
// Reset trigger when switching tabs so stale values don't open modals
useEffect(() => { setNewEntryTrigger(0); }, [activeTab]);
```

---

## Step 2: RacksTab.jsx

### 2a. Change state management pattern

**Before (line ~13):**
```jsx
const [editId, setEditId]     = useState(null);
```

**After:**
```jsx
const [editState, setEditState] = useState({ id: null, open: false });
```

### 2b. Add `newEntryTrigger` prop and effect

**Before (line ~7):**
```jsx
function RacksTabContent() {
```

**After:**
```jsx
function RacksTabContent({ newEntryTrigger }) {
```

**Add after state declarations (after `confirmDeleteId` state, ~line 18):**
```jsx
// Open the new-entry form whenever the parent increments the trigger
useEffect(() => {
  if (newEntryTrigger > 0) { startNew(); }
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [newEntryTrigger]);
```

### 2c. Update resetForm and startEdit, add startNew

**Before:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_RACK_FORM }); setEditId(null); setErr(""); };
const startEdit = (r) => { setEditId(r.id); setForm({ label: r.label, room: r.room, description: r.description }); setErr(""); };
```

**After:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_RACK_FORM }); setEditState({ id: null, open: false }); setErr(""); };

const startNew = () => {
  setForm({ ...EMPTY_RACK_FORM });
  setEditState({ id: null, open: true });
  setErr("");
};

const startEdit = (r) => {
  setForm({ label: r.label, room: r.room, description: r.description });
  setEditState({ id: r.id, open: true });
  setErr("");
};
```

### 2d. Update submit to use editState

**Before:**
```jsx
if (editId) { await api.put(`/api/racks/${editId}`, form); }
```

**After:**
```jsx
if (editState.id) { await api.put(`/api/racks/${editState.id}`, form); }
```

### 2e. Update input styling constants to match CredentialsTab

**Before:**
```jsx
const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };
```

**After:**
```jsx
const inp = {
  backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
  color:"#e2e8f0", padding:"5px 8px",
  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
};
const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });
```

### 2f. Replace inline form with modal overlay

**Before (the entire `<form>` block at the top of the return):**
```jsx
<form onSubmit={submit} style={{ backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:8, padding:14, display:"flex", flexDirection:"column", gap:8 }}>
  <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:4 }}>
    {editId ? "EDIT RACK" : "NEW RACK"}
  </div>
  <div><label style={LBL}>Label</label>
    <input required style={INPUT} value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Rack A" /></div>
  <div><label style={LBL}>Room / location</label>
    <input style={INPUT} value={form.room} onChange={e => setForm(f => ({...f, room:e.target.value}))} placeholder="e.g. RZ-01" /></div>
  <div><label style={LBL}>Description</label>
    <input style={INPUT} value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" /></div>
  {err && <div style={{ color:"#f87171", fontSize:11 }}>{err}</div>}
  <div style={{ display:"flex", gap:6 }}>
    <button type="submit" style={{ ...BTNP, flex:1 }}>{editId ? "Save" : "Create rack"}</button>
    {editId && <button type="button" onClick={resetForm} style={{ backgroundColor:"transparent", border:"1px solid #1e293b", color:"#64748b", borderRadius:6, padding:"6px 12px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11 }}>Cancel</button>}
  </div>
</form>
```

**After (modal overlay, placed BEFORE the card grid in the return):**
```jsx
{editState.open && (
  <div
    onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
    style={{
      position:"fixed", inset:0, zIndex:200,
      backgroundColor:"rgba(2,8,23,0.75)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }}
  >
    <form onSubmit={submit} style={{
      width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
      backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
      padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
    }}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
          {editState.id ? "EDIT RACK" : "NEW RACK"}
        </div>
        <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <label style={lbl()}>Label *
          <input required value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Rack A" style={{...inp,marginTop:3}}/>
        </label>
        <label style={lbl()}>Room / location
          <input value={form.room} onChange={e => setForm(f => ({...f, room:e.target.value}))} placeholder="e.g. RZ-01" style={{...inp,marginTop:3}}/>
        </label>
        <label style={{...lbl(), gridColumn:"1 / -1"}}>Description
          <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
        </label>
      </div>
      {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
      <div style={{display:"flex",gap:8}}>
        <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
          {editState.id ? "Save changes" : "+ Add"}
        </button>
        <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
          Cancel
        </button>
      </div>
    </form>
  </div>
)}
```

### 2g. Convert listing from vertical stack to card grid

**Before (the listing container is implicit -- `racks.map(...)` renders stacked divs):**
```jsx
) : racks.map(rack => {
  // ...each rack renders a standalone <div>
})
```

**After (wrap in a grid container):**
```jsx
) : (
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
  {racks.map(rack => {
    // ...card content (same card internals -- see 2h)
  })}
  </div>
)
```

### 2h. Update card Edit buttons to use `startEdit` -> opens modal

The card `Edit` button already calls `startEdit(rack)`, which now opens the modal (via `setEditState({ id: r.id, open: true })`). No change needed in the button handler itself.

### 2i. Update references from `editId` to `editState.id` in the listing

Any remaining references to `editId` in the card rendering (there are none in the current RacksTab card markup) are not present, so no changes needed in the card body.

### Full RacksTab.jsx after conversion

```jsx
import { useState, useEffect } from "react";
import { api } from "../../api.js";

const EMPTY_RACK_FORM = { label: "", room: "", description: "" };

function RacksTabContent({ newEntryTrigger }) {
  const [racks, setRacks]       = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editState, setEditState] = useState({ id: null, open: false });
  const [form, setForm]         = useState({ ...EMPTY_RACK_FORM });
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const refreshAll = () => {
    setLoading(true);
    Promise.allSettled([api.get("/api/racks"), api.get("/api/topology")])
      .then(([racksRes, topoRes]) => {
        if (racksRes.status === "fulfilled") setRacks(racksRes.value);
        else setRacks([]);
        if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
        else setDevices([]);
        setLoading(false);
      });
  };
  useEffect(() => { refreshAll(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_RACK_FORM }); setEditState({ id: null, open: false }); setErr(""); };

  const startNew = () => {
    setForm({ ...EMPTY_RACK_FORM });
    setEditState({ id: null, open: true });
    setErr("");
  };

  const startEdit = (r) => {
    setForm({ label: r.label, room: r.room, description: r.description });
    setEditState({ id: r.id, open: true });
    setErr("");
  };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.label.trim()) { setErr("Label is required"); return; }
      if (editState.id) { await api.put(`/api/racks/${editState.id}`, form); }
      else {
        const r = await api.post("/api/racks", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refreshAll();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = (id) => setConfirmDeleteId(id);
  const removeConfirmed = async (id) => {
    await api.del(`/api/racks/${id}`); setConfirmDeleteId(null); refreshAll();
  };

  const assignDevice = async (rackId) => {
    const devId = assignSel[rackId];
    if (!devId) return;
    await api.patch(`/api/topology/devices/${devId}/meta`, { rack_id: rackId });
    api.invalidate("/api/topology", "/api/racks");
    setAssignSel(prev => ({ ...prev, [rackId]: "" }));
    refreshAll();
  };

  const unassignDevice = async (devId) => {
    await api.patch(`/api/topology/devices/${devId}/meta`, { rack_id: null });
    api.invalidate("/api/topology", "/api/racks");
    refreshAll();
  };

  const inp = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
    color:"#e2e8f0", padding:"5px 8px",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
  };
  const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>

      {/* Modal overlay for new / edit form */}
      {editState.open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
          style={{
            position:"fixed", inset:0, zIndex:200,
            backgroundColor:"rgba(2,8,23,0.75)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}
        >
          <form onSubmit={submit} style={{
            width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
            padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
                {editState.id ? "EDIT RACK" : "NEW RACK"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <label style={lbl()}>Label *
                <input required value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Rack A" style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>Room / location
                <input value={form.room} onChange={e => setForm(f => ({...f, room:e.target.value}))} placeholder="e.g. RZ-01" style={{...inp,marginTop:3}}/>
              </label>
              <label style={{...lbl(), gridColumn:"1 / -1"}}>Description
                <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
              </label>
            </div>
            {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
            <div style={{display:"flex",gap:8}}>
              <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
                {editState.id ? "Save changes" : "+ Add"}
              </button>
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>Loading...</div>
      ) : racks.length === 0 ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>No racks defined yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
        {racks.map(rack => {
          const assigned  = devices.filter(d => d.rack_id === rack.id);
          const available = devices.filter(d => d.rack_id == null && (d.ports || []).length > 0);
          const selVal    = assignSel[rack.id] || "";
          return (
            <div key={rack.id} style={{
              display:"flex", flexDirection:"column",
              padding:"10px 12px",
              backgroundColor:"#0a0e18",
              border:"1px solid #1e293b",
              borderRadius:8,
            }}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                <div style={{minWidth:0,flex:1}}>
                  <div style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{rack.label}</div>
                  {(rack.room || rack.description) && (
                    <div style={{color:"#475569",fontSize:10,marginTop:2}}>
                      {rack.room}{rack.room && rack.description ? " - " : ""}{rack.description}
                    </div>
                  )}
                </div>
              </div>
              <div style={{marginTop:6,borderTop:"1px solid #0f172a",paddingTop:8}}>
                <div style={{color:"#475569",fontSize:10,letterSpacing:1,marginBottom:6}}>
                  ASSIGNED SWITCHES ({assigned.length})
                </div>
                {assigned.length > 0 && (
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                    {assigned.map(d => (
                      <div key={d.id} style={{backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",borderRadius:4,padding:"2px 6px 2px 8px",display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                        <span style={{color:"#7dd3fc"}}>{d.sys_name || d.ip}</span>
                        <span style={{color:"#334155",fontSize:10}}>{d.ip}</span>
                        <button onClick={() => unassignDevice(d.id)} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:"0 2px",fontSize:11,lineHeight:1}} title="Unassign">x</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{display:"flex",gap:4}}>
                  <select value={selVal} onChange={e => setAssignSel(p => ({...p, [rack.id]:e.target.value}))}
                    style={{flex:1,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:4,padding:"4px 6px",color:selVal?"#e2e8f0":"#475569",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                    <option value="">-- Assign switch --</option>
                    {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                  </select>
                  <button onClick={() => assignDevice(rack.id)} disabled={!selVal}
                    style={{backgroundColor:selVal?"#083344":"#0a0e18",border:"1px solid #164e63",color:selVal?"#22d3ee":"#1e3a5f",borderRadius:4,padding:"4px 10px",cursor:selVal?"pointer":"not-allowed",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                    Assign
                  </button>
                </div>
              </div>
              <div style={{display:"flex",gap:5,justifyContent:"flex-end",marginTop:8}}>
                <button onClick={() => startEdit(rack)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
                {confirmDeleteId === rack.id ? (
                  <span style={{display:"flex",gap:4}}>
                    <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(rack.id)}>Confirm</button>
                    <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => remove(rack.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
                )}
              </div>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}

export default RacksTabContent;
```

---

## Step 3: SwitchClassesTab.jsx

### 3a. Change state management pattern

**Before (line ~13):**
```jsx
const [editId, setEditId]     = useState(null);
```

**After:**
```jsx
const [editState, setEditState] = useState({ id: null, open: false });
```

### 3b. Add `newEntryTrigger` prop and effect

**Before (line ~7):**
```jsx
function ClassesTabContent() {
```

**After:**
```jsx
function ClassesTabContent({ newEntryTrigger }) {
```

**Add after state declarations:**
```jsx
useEffect(() => {
  if (newEntryTrigger > 0) { startNew(); }
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [newEntryTrigger]);
```

### 3c. Update resetForm, startEdit, add startNew

**Before:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditId(null); setErr(""); };
const startEdit = (sc) => {
  setEditId(sc.id);
  setForm({
    label: sc.label,
    description: sc.description,
    color: sc.color,
    allow_outside_rack: !!sc.allow_outside_rack,
  });
  setErr("");
};
```

**After:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: false }); setErr(""); };

const startNew = () => {
  setForm({ ...EMPTY_CLASS_FORM });
  setEditState({ id: null, open: true });
  setErr("");
};

const startEdit = (sc) => {
  setForm({
    label: sc.label,
    description: sc.description,
    color: sc.color,
    allow_outside_rack: !!sc.allow_outside_rack,
  });
  setEditState({ id: sc.id, open: true });
  setErr("");
};
```

### 3d. Update submit to use editState

**Before:**
```jsx
if (editId) { await api.put(`/api/switch-classes/${editId}`, form); }
```

**After:**
```jsx
if (editState.id) { await api.put(`/api/switch-classes/${editState.id}`, form); }
```

### 3e. Update input styling constants

**Before:**
```jsx
const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };
```

**After:**
```jsx
const inp = {
  backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
  color:"#e2e8f0", padding:"5px 8px",
  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
};
const sel = { ...inp, cursor:"pointer" };
const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });
```

### 3f. Replace inline form with modal overlay

The modal contains: Label, Color picker, Description, Allow outside rack checkbox. Two-column grid with color picker inline.

**After (modal overlay):**
```jsx
{editState.open && (
  <div
    onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
    style={{
      position:"fixed", inset:0, zIndex:200,
      backgroundColor:"rgba(2,8,23,0.75)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }}
  >
    <form onSubmit={submit} style={{
      width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
      backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
      padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
    }}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
          {editState.id ? "EDIT CLASS" : "NEW CLASS"}
        </div>
        <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:8}}>
        <label style={lbl()}>Label *
          <input required value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Top of Rack" style={{...inp,marginTop:3}}/>
        </label>
        <label style={lbl()}>Color
          <input type="color" value={form.color} onChange={e => setForm(f => ({...f, color:e.target.value}))}
            style={{width:40,height:29,padding:2,backgroundColor:"#0c0f18",border:"1px solid #1e293b",borderRadius:5,cursor:"pointer",marginTop:3,display:"block"}} />
        </label>
      </div>
      <div style={{marginBottom:8}}>
        <label style={lbl()}>Description
          <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
        </label>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:6,color:"#94a3b8",fontSize:11,cursor:"pointer",marginBottom:12}}>
        <input
          type="checkbox"
          checked={!!form.allow_outside_rack}
          onChange={e => setForm(f => ({ ...f, allow_outside_rack: e.target.checked }))}
        />
        Allow outside rack placement
      </label>
      {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
      <div style={{display:"flex",gap:8}}>
        <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
          {editState.id ? "Save changes" : "+ Add"}
        </button>
        <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
          Cancel
        </button>
      </div>
    </form>
  </div>
)}
```

### 3g. Convert listing from vertical stack to card grid

Wrap in grid container. Keep the color accent bar and color dot on each card. Move action buttons to bottom-right of card (matching CredentialsTab layout).

**After (card grid with adapted card content):**
```jsx
) : (
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
  {classes.map(sc => {
    const assigned  = devices.filter(d => d.class_id === sc.id);
    const available = devices.filter(d => d.class_id == null && (d.ports || []).length > 0);
    const selVal    = assignSel[sc.id] || "";
    return (
      <div key={sc.id} style={{
        display:"flex", flexDirection:"column",
        padding:"10px 12px",
        backgroundColor:"#0a0e18",
        border:`1px solid ${sc.color}44`,
        borderRadius:8,
        position:"relative", overflow:"hidden",
      }}>
        <div style={{position:"absolute",top:0,left:0,width:3,bottom:0,backgroundColor:sc.color,borderRadius:"8px 0 0 8px"}} />
        <div style={{marginLeft:12}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
            <div style={{minWidth:0,flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <div style={{width:9,height:9,borderRadius:"50%",backgroundColor:sc.color,flexShrink:0}} />
                <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{sc.label}</span>
                <span style={{
                  fontSize:10,padding:"1px 6px",borderRadius:4,
                  border:`1px solid ${sc.allow_outside_rack ? "#14532d" : "#1e293b"}`,
                  backgroundColor: sc.allow_outside_rack ? "#052e16" : "#0a0e18",
                  color: sc.allow_outside_rack ? "#4ade80" : "#64748b",
                }}>
                  {sc.allow_outside_rack ? "Outside allowed" : "Rack required"}
                </span>
              </div>
              {sc.description && <div style={{color:"#475569",fontSize:10,marginTop:2,marginLeft:17}}>{sc.description}</div>}
            </div>
          </div>
          <div style={{marginTop:6,borderTop:"1px solid #0f172a",paddingTop:8}}>
            <div style={{color:"#475569",fontSize:10,letterSpacing:1,marginBottom:6}}>
              ASSIGNED SWITCHES ({assigned.length})
            </div>
            {assigned.length > 0 && (
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                {assigned.map(d => (
                  <div key={d.id} style={{backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",borderRadius:4,padding:"2px 6px 2px 8px",display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                    <span style={{color:"#7dd3fc"}}>{d.sys_name || d.ip}</span>
                    <span style={{color:"#334155",fontSize:10}}>{d.ip}</span>
                    <button onClick={() => unassignDevice(d.id)} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:"0 2px",fontSize:11,lineHeight:1}} title="Unassign">x</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{display:"flex",gap:4}}>
              <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sc.id]:e.target.value}))}
                style={{flex:1,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:4,padding:"4px 6px",color:selVal?"#e2e8f0":"#475569",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                <option value="">-- Assign switch --</option>
                {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
              </select>
              <button onClick={() => assignDevice(sc.id)} disabled={!selVal}
                style={{backgroundColor:selVal?"#083344":"#0a0e18",border:"1px solid #164e63",color:selVal?"#22d3ee":"#1e3a5f",borderRadius:4,padding:"4px 10px",cursor:selVal?"pointer":"not-allowed",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                Assign
              </button>
            </div>
          </div>
          <div style={{display:"flex",gap:5,justifyContent:"flex-end",marginTop:8}}>
            <button onClick={() => startEdit(sc)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
            {confirmDeleteId === sc.id ? (
              <span style={{display:"flex",gap:4}}>
                <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(sc.id)}>Confirm</button>
                <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
              </span>
            ) : (
              <button onClick={() => remove(sc.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
            )}
          </div>
        </div>
      </div>
    );
  })}
  </div>
)
```

### Full SwitchClassesTab.jsx after conversion

```jsx
import { useState, useEffect } from "react";
import { api } from "../../api.js";

const EMPTY_CLASS_FORM = { label: "", description: "", color: "#3b82f6", allow_outside_rack: false };

function ClassesTabContent({ newEntryTrigger }) {
  const [classes, setClasses]   = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editState, setEditState] = useState({ id: null, open: false });
  const [form, setForm]         = useState({ ...EMPTY_CLASS_FORM });
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const refreshAll = () => {
    setLoading(true);
    Promise.allSettled([api.get("/api/switch-classes"), api.get("/api/topology")])
      .then(([classesRes, topoRes]) => {
        if (classesRes.status === "fulfilled") setClasses(classesRes.value);
        else setClasses([]);
        if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
        else setDevices([]);
        setLoading(false);
      });
  };
  useEffect(() => { refreshAll(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: false }); setErr(""); };

  const startNew = () => {
    setForm({ ...EMPTY_CLASS_FORM });
    setEditState({ id: null, open: true });
    setErr("");
  };

  const startEdit = (sc) => {
    setForm({
      label: sc.label,
      description: sc.description,
      color: sc.color,
      allow_outside_rack: !!sc.allow_outside_rack,
    });
    setEditState({ id: sc.id, open: true });
    setErr("");
  };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.label.trim()) { setErr("Label is required"); return; }
      if (editState.id) { await api.put(`/api/switch-classes/${editState.id}`, form); }
      else {
        const r = await api.post("/api/switch-classes", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refreshAll();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = (id) => setConfirmDeleteId(id);
  const removeConfirmed = async (id) => {
    await api.del(`/api/switch-classes/${id}`); setConfirmDeleteId(null); refreshAll();
  };

  const assignDevice = async (classId) => {
    const devId = assignSel[classId];
    if (!devId) return;
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: classId });
      api.invalidate("/api/topology");
      setAssignSel(prev => ({ ...prev, [classId]: "" }));
      refreshAll();
    } catch (ex) {
      setErr(String(ex));
    }
  };

  const unassignDevice = async (devId) => {
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: null });
      api.invalidate("/api/topology");
      refreshAll();
    } catch (ex) {
      setErr(String(ex));
    }
  };

  const inp = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
    color:"#e2e8f0", padding:"5px 8px",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
  };
  const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>

      {/* Modal overlay for new / edit form */}
      {editState.open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
          style={{
            position:"fixed", inset:0, zIndex:200,
            backgroundColor:"rgba(2,8,23,0.75)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}
        >
          <form onSubmit={submit} style={{
            width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
            padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
                {editState.id ? "EDIT CLASS" : "NEW CLASS"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:8}}>
              <label style={lbl()}>Label *
                <input required value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Top of Rack" style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>Color
                <input type="color" value={form.color} onChange={e => setForm(f => ({...f, color:e.target.value}))}
                  style={{width:40,height:29,padding:2,backgroundColor:"#0c0f18",border:"1px solid #1e293b",borderRadius:5,cursor:"pointer",marginTop:3,display:"block"}} />
              </label>
            </div>
            <div style={{marginBottom:8}}>
              <label style={lbl()}>Description
                <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
              </label>
            </div>
            <label style={{display:"flex",alignItems:"center",gap:6,color:"#94a3b8",fontSize:11,cursor:"pointer",marginBottom:12}}>
              <input
                type="checkbox"
                checked={!!form.allow_outside_rack}
                onChange={e => setForm(f => ({ ...f, allow_outside_rack: e.target.checked }))}
              />
              Allow outside rack placement
            </label>
            {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
            <div style={{display:"flex",gap:8}}>
              <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
                {editState.id ? "Save changes" : "+ Add"}
              </button>
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>Loading...</div>
      ) : classes.length === 0 ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>No classes defined yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
        {classes.map(sc => {
          const assigned  = devices.filter(d => d.class_id === sc.id);
          const available = devices.filter(d => d.class_id == null && (d.ports || []).length > 0);
          const selVal    = assignSel[sc.id] || "";
          return (
            <div key={sc.id} style={{
              display:"flex", flexDirection:"column",
              padding:"10px 12px",
              backgroundColor:"#0a0e18",
              border:`1px solid ${sc.color}44`,
              borderRadius:8,
              position:"relative", overflow:"hidden",
            }}>
              <div style={{position:"absolute",top:0,left:0,width:3,bottom:0,backgroundColor:sc.color,borderRadius:"8px 0 0 8px"}} />
              <div style={{marginLeft:12}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <div style={{width:9,height:9,borderRadius:"50%",backgroundColor:sc.color,flexShrink:0}} />
                      <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{sc.label}</span>
                      <span style={{
                        fontSize:10,padding:"1px 6px",borderRadius:4,
                        border:`1px solid ${sc.allow_outside_rack ? "#14532d" : "#1e293b"}`,
                        backgroundColor: sc.allow_outside_rack ? "#052e16" : "#0a0e18",
                        color: sc.allow_outside_rack ? "#4ade80" : "#64748b",
                      }}>
                        {sc.allow_outside_rack ? "Outside allowed" : "Rack required"}
                      </span>
                    </div>
                    {sc.description && <div style={{color:"#475569",fontSize:10,marginTop:2,marginLeft:17}}>{sc.description}</div>}
                  </div>
                </div>
                <div style={{marginTop:6,borderTop:"1px solid #0f172a",paddingTop:8}}>
                  <div style={{color:"#475569",fontSize:10,letterSpacing:1,marginBottom:6}}>
                    ASSIGNED SWITCHES ({assigned.length})
                  </div>
                  {assigned.length > 0 && (
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                      {assigned.map(d => (
                        <div key={d.id} style={{backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",borderRadius:4,padding:"2px 6px 2px 8px",display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                          <span style={{color:"#7dd3fc"}}>{d.sys_name || d.ip}</span>
                          <span style={{color:"#334155",fontSize:10}}>{d.ip}</span>
                          <button onClick={() => unassignDevice(d.id)} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:"0 2px",fontSize:11,lineHeight:1}} title="Unassign">x</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{display:"flex",gap:4}}>
                    <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sc.id]:e.target.value}))}
                      style={{flex:1,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:4,padding:"4px 6px",color:selVal?"#e2e8f0":"#475569",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                      <option value="">-- Assign switch --</option>
                      {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                    </select>
                    <button onClick={() => assignDevice(sc.id)} disabled={!selVal}
                      style={{backgroundColor:selVal?"#083344":"#0a0e18",border:"1px solid #164e63",color:selVal?"#22d3ee":"#1e3a5f",borderRadius:4,padding:"4px 10px",cursor:selVal?"pointer":"not-allowed",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                      Assign
                    </button>
                  </div>
                </div>
                <div style={{display:"flex",gap:5,justifyContent:"flex-end",marginTop:8}}>
                  <button onClick={() => startEdit(sc)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
                  {confirmDeleteId === sc.id ? (
                    <span style={{display:"flex",gap:4}}>
                      <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(sc.id)}>Confirm</button>
                      <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => remove(sc.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}

export default ClassesTabContent;
```

---

## Step 4: SwitchModelsTab.jsx

### 4a. Change state management pattern

**Before (line ~13):**
```jsx
const [editId, setEditId]     = useState(null);
```

**After:**
```jsx
const [editState, setEditState] = useState({ id: null, open: false });
```

### 4b. Add `newEntryTrigger` prop and effect

**Before (line ~7):**
```jsx
function ModelsTabContent() {
```

**After:**
```jsx
function ModelsTabContent({ newEntryTrigger }) {
```

**Add after state declarations:**
```jsx
useEffect(() => {
  if (newEntryTrigger > 0) { startNew(); }
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [newEntryTrigger]);
```

### 4c. Update resetForm, startEdit, add startNew

**Before:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_MODEL_FORM }); setCutoffEnabled(false); setEditId(null); setErr(""); };
const startEdit = (sm) => {
  setEditId(sm.id);
  setForm({ name: sm.name, ports_per_row: sm.ports_per_row, total_ports: sm.total_ports ?? "", description: sm.description });
  setCutoffEnabled(sm.total_ports != null);
  setErr("");
};
```

**After:**
```jsx
const resetForm = () => { setForm({ ...EMPTY_MODEL_FORM }); setCutoffEnabled(false); setEditState({ id: null, open: false }); setErr(""); };

const startNew = () => {
  setForm({ ...EMPTY_MODEL_FORM });
  setCutoffEnabled(false);
  setEditState({ id: null, open: true });
  setErr("");
};

const startEdit = (sm) => {
  setForm({ name: sm.name, ports_per_row: sm.ports_per_row, total_ports: sm.total_ports ?? "", description: sm.description });
  setCutoffEnabled(sm.total_ports != null);
  setEditState({ id: sm.id, open: true });
  setErr("");
};
```

### 4d. Update submit to use editState

**Before:**
```jsx
if (editId) { await api.put(`/api/switch-models/${editId}`, payload); }
```

**After:**
```jsx
if (editState.id) { await api.put(`/api/switch-models/${editState.id}`, payload); }
```

### 4e. Update input styling constants

**Before:**
```jsx
const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };
```

**After:**
```jsx
const inp = {
  backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
  color:"#e2e8f0", padding:"5px 8px",
  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
};
const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });
```

### 4f. Replace inline form with modal overlay

The modal contains: Name, Ports per row, Total ports cutoff toggle + input, Description. Use a 2-column grid for Name + Ports per row, then cutoff as a full-width row, then description full-width.

**After (modal overlay):**
```jsx
{editState.open && (
  <div
    onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
    style={{
      position:"fixed", inset:0, zIndex:200,
      backgroundColor:"rgba(2,8,23,0.75)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }}
  >
    <form onSubmit={submit} style={{
      width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
      backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
      padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
    }}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
          {editState.id ? "EDIT MODEL" : "NEW MODEL"}
        </div>
        <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <label style={lbl()}>Name *
          <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} placeholder="e.g. Aruba CX 6300M-48" style={{...inp,marginTop:3}}/>
        </label>
        <label style={lbl()}>Ports per row
          <input type="number" min="1" max="96" value={form.ports_per_row} onChange={e => setForm(f => ({...f, ports_per_row:e.target.value}))} style={{...inp,marginTop:3}}/>
        </label>
      </div>
      <div style={{marginBottom:8}}>
        <label style={lbl()} title="Ports beyond this count (sorted by index) are hidden. Use to suppress aggregation or uplink ports that appear as regular ports on some devices.">
          Total ports (cutoff)
        </label>
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:3}}>
          <div
            onClick={() => { setCutoffEnabled(v => !v); if (cutoffEnabled) setForm(f => ({...f, total_ports:""})); }}
            style={{
              width:32, height:18, borderRadius:9, cursor:"pointer", flexShrink:0,
              backgroundColor: cutoffEnabled ? "#0e7490" : "#1e293b",
              border: `1px solid ${cutoffEnabled ? "#22d3ee" : "#334155"}`,
              position:"relative", transition:"background 0.2s, border 0.2s",
            }}>
            <div style={{
              position:"absolute", top:2, left: cutoffEnabled ? 14 : 2,
              width:12, height:12, borderRadius:"50%",
              backgroundColor: cutoffEnabled ? "#22d3ee" : "#475569",
              transition:"left 0.2s, background 0.2s",
            }}/>
          </div>
          {cutoffEnabled && (
            <input
              type="number" min="1"
              style={{...inp, width:"auto", flex:1}}
              value={form.total_ports}
              onChange={e => setForm(f => ({...f, total_ports:e.target.value}))}
              placeholder="e.g. 48"
              autoFocus
            />
          )}
          {!cutoffEnabled && (
            <span style={{color:"#334155",fontSize:10}}>disabled</span>
          )}
        </div>
      </div>
      <div style={{marginBottom:8}}>
        <label style={lbl()}>Description
          <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
        </label>
      </div>
      {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
      <div style={{display:"flex",gap:8}}>
        <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
          {editState.id ? "Save changes" : "+ Add"}
        </button>
        <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
          Cancel
        </button>
      </div>
    </form>
  </div>
)}
```

### 4g. Convert listing from vertical stack to card grid

Keep cyan accent bar, port count badge, total ports info. Move action buttons to bottom-right.

**After (card grid with adapted card content):**
```jsx
) : (
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
  {models.map(sm => {
    const assigned  = devices.filter(d => d.model_id === sm.id);
    const available = devices.filter(d => d.model_id == null && (d.ports || []).length > 0);
    const selVal    = assignSel[sm.id] || "";
    return (
      <div key={sm.id} style={{
        display:"flex", flexDirection:"column",
        padding:"10px 12px",
        backgroundColor:"#0a0e18",
        border:"1px solid #1e293b",
        borderRadius:8,
        position:"relative", overflow:"hidden",
      }}>
        <div style={{position:"absolute",top:0,left:0,width:3,bottom:0,backgroundColor:"#22d3ee",borderRadius:"8px 0 0 8px"}} />
        <div style={{marginLeft:12}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
            <div style={{minWidth:0,flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{sm.name}</span>
                <span style={{color:"#22d3ee",fontSize:10,backgroundColor:"#083344",padding:"1px 6px",borderRadius:3,border:"1px solid #164e63"}}>
                  {sm.ports_per_row} ports/row
                </span>
                {sm.total_ports != null && (
                  <span style={{color:"#64748b",fontSize:10}}>{sm.total_ports} total</span>
                )}
              </div>
              {sm.description && <div style={{color:"#475569",fontSize:10,marginTop:2}}>{sm.description}</div>}
            </div>
          </div>
          <div style={{marginTop:6,borderTop:"1px solid #0f172a",paddingTop:8}}>
            <div style={{color:"#475569",fontSize:10,letterSpacing:1,marginBottom:6}}>
              ASSIGNED SWITCHES ({assigned.length})
            </div>
            {assigned.length > 0 && (
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                {assigned.map(d => (
                  <div key={d.id} style={{backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",borderRadius:4,padding:"2px 6px 2px 8px",display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                    <span style={{color:"#7dd3fc"}}>{d.sys_name || d.ip}</span>
                    <span style={{color:"#334155",fontSize:10}}>{d.ip}</span>
                    <button onClick={() => unassignDevice(d.id)} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:"0 2px",fontSize:11,lineHeight:1}} title="Unassign">x</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{display:"flex",gap:4}}>
              <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sm.id]:e.target.value}))}
                style={{flex:1,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:4,padding:"4px 6px",color:selVal?"#e2e8f0":"#475569",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                <option value="">-- Assign switch --</option>
                {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
              </select>
              <button onClick={() => assignDevice(sm.id)} disabled={!selVal}
                style={{backgroundColor:selVal?"#083344":"#0a0e18",border:"1px solid #164e63",color:selVal?"#22d3ee":"#1e3a5f",borderRadius:4,padding:"4px 10px",cursor:selVal?"pointer":"not-allowed",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                Assign
              </button>
            </div>
          </div>
          <div style={{display:"flex",gap:5,justifyContent:"flex-end",marginTop:8}}>
            <button onClick={() => startEdit(sm)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
            {confirmDeleteId === sm.id ? (
              <span style={{display:"flex",gap:4}}>
                <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(sm.id)}>Confirm</button>
                <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
              </span>
            ) : (
              <button onClick={() => remove(sm.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
            )}
          </div>
        </div>
      </div>
    );
  })}
  </div>
)
```

### Full SwitchModelsTab.jsx after conversion

```jsx
import { useState, useEffect } from "react";
import { api } from "../../api.js";

const EMPTY_MODEL_FORM = { name: "", ports_per_row: 24, total_ports: "", description: "" };

function ModelsTabContent({ newEntryTrigger }) {
  const [models, setModels]     = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editState, setEditState] = useState({ id: null, open: false });
  const [form, setForm]         = useState({ ...EMPTY_MODEL_FORM });
  const [cutoffEnabled, setCutoffEnabled] = useState(false);
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const refreshAll = () => {
    setLoading(true);
    Promise.allSettled([api.get("/api/switch-models"), api.get("/api/topology")])
      .then(([modelsRes, topoRes]) => {
        if (modelsRes.status === "fulfilled") setModels(modelsRes.value);
        else setModels([]);
        if (topoRes.status === "fulfilled") setDevices(topoRes.value?.nodes || []);
        else setDevices([]);
        setLoading(false);
      });
  };
  useEffect(() => { refreshAll(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_MODEL_FORM }); setCutoffEnabled(false); setEditState({ id: null, open: false }); setErr(""); };

  const startNew = () => {
    setForm({ ...EMPTY_MODEL_FORM });
    setCutoffEnabled(false);
    setEditState({ id: null, open: true });
    setErr("");
  };

  const startEdit = (sm) => {
    setForm({ name: sm.name, ports_per_row: sm.ports_per_row, total_ports: sm.total_ports ?? "", description: sm.description });
    setCutoffEnabled(sm.total_ports != null);
    setEditState({ id: sm.id, open: true });
    setErr("");
  };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.name.trim()) { setErr("Name is required"); return; }
      const ppr = parseInt(form.ports_per_row, 10);
      if (isNaN(ppr) || ppr < 1) { setErr("Ports per row must be a positive number"); return; }
      const payload = {
        name: form.name.trim(),
        ports_per_row: ppr,
        total_ports: cutoffEnabled && form.total_ports !== "" ? parseInt(form.total_ports, 10) || null : null,
        description: form.description,
      };
      if (editState.id) { await api.put(`/api/switch-models/${editState.id}`, payload); }
      else {
        const r = await api.post("/api/switch-models", payload);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refreshAll();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = (id) => setConfirmDeleteId(id);
  const removeConfirmed = async (id) => {
    await api.del(`/api/switch-models/${id}`); setConfirmDeleteId(null); refreshAll();
  };

  const assignDevice = async (modelId) => {
    const devId = assignSel[modelId];
    if (!devId) return;
    await api.patch(`/api/topology/devices/${devId}/meta`, { model_id: modelId });
    api.invalidate("/api/topology");
    setAssignSel(prev => ({ ...prev, [modelId]: "" }));
    refreshAll();
  };

  const unassignDevice = async (devId) => {
    await api.patch(`/api/topology/devices/${devId}/meta`, { model_id: null });
    api.invalidate("/api/topology");
    refreshAll();
  };

  const inp = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
    color:"#e2e8f0", padding:"5px 8px",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
  };
  const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>

      {/* Modal overlay for new / edit form */}
      {editState.open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
          style={{
            position:"fixed", inset:0, zIndex:200,
            backgroundColor:"rgba(2,8,23,0.75)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}
        >
          <form onSubmit={submit} style={{
            width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
            padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
                {editState.id ? "EDIT MODEL" : "NEW MODEL"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <label style={lbl()}>Name *
                <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} placeholder="e.g. Aruba CX 6300M-48" style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>Ports per row
                <input type="number" min="1" max="96" value={form.ports_per_row} onChange={e => setForm(f => ({...f, ports_per_row:e.target.value}))} style={{...inp,marginTop:3}}/>
              </label>
            </div>
            <div style={{marginBottom:8}}>
              <label style={lbl()} title="Ports beyond this count (sorted by index) are hidden. Use to suppress aggregation or uplink ports that appear as regular ports on some devices.">
                Total ports (cutoff)
              </label>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:3}}>
                <div
                  onClick={() => { setCutoffEnabled(v => !v); if (cutoffEnabled) setForm(f => ({...f, total_ports:""})); }}
                  style={{
                    width:32, height:18, borderRadius:9, cursor:"pointer", flexShrink:0,
                    backgroundColor: cutoffEnabled ? "#0e7490" : "#1e293b",
                    border: `1px solid ${cutoffEnabled ? "#22d3ee" : "#334155"}`,
                    position:"relative", transition:"background 0.2s, border 0.2s",
                  }}>
                  <div style={{
                    position:"absolute", top:2, left: cutoffEnabled ? 14 : 2,
                    width:12, height:12, borderRadius:"50%",
                    backgroundColor: cutoffEnabled ? "#22d3ee" : "#475569",
                    transition:"left 0.2s, background 0.2s",
                  }}/>
                </div>
                {cutoffEnabled && (
                  <input
                    type="number" min="1"
                    style={{...inp, width:"auto", flex:1}}
                    value={form.total_ports}
                    onChange={e => setForm(f => ({...f, total_ports:e.target.value}))}
                    placeholder="e.g. 48"
                    autoFocus
                  />
                )}
                {!cutoffEnabled && (
                  <span style={{color:"#334155",fontSize:10}}>disabled</span>
                )}
              </div>
            </div>
            <div style={{marginBottom:8}}>
              <label style={lbl()}>Description
                <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" style={{...inp,marginTop:3}}/>
              </label>
            </div>
            {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
            <div style={{display:"flex",gap:8}}>
              <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
                {editState.id ? "Save changes" : "+ Add"}
              </button>
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>Loading...</div>
      ) : models.length === 0 ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>No models defined yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
        {models.map(sm => {
          const assigned  = devices.filter(d => d.model_id === sm.id);
          const available = devices.filter(d => d.model_id == null && (d.ports || []).length > 0);
          const selVal    = assignSel[sm.id] || "";
          return (
            <div key={sm.id} style={{
              display:"flex", flexDirection:"column",
              padding:"10px 12px",
              backgroundColor:"#0a0e18",
              border:"1px solid #1e293b",
              borderRadius:8,
              position:"relative", overflow:"hidden",
            }}>
              <div style={{position:"absolute",top:0,left:0,width:3,bottom:0,backgroundColor:"#22d3ee",borderRadius:"8px 0 0 8px"}} />
              <div style={{marginLeft:12}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{sm.name}</span>
                      <span style={{color:"#22d3ee",fontSize:10,backgroundColor:"#083344",padding:"1px 6px",borderRadius:3,border:"1px solid #164e63"}}>
                        {sm.ports_per_row} ports/row
                      </span>
                      {sm.total_ports != null && (
                        <span style={{color:"#64748b",fontSize:10}}>{sm.total_ports} total</span>
                      )}
                    </div>
                    {sm.description && <div style={{color:"#475569",fontSize:10,marginTop:2}}>{sm.description}</div>}
                  </div>
                </div>
                <div style={{marginTop:6,borderTop:"1px solid #0f172a",paddingTop:8}}>
                  <div style={{color:"#475569",fontSize:10,letterSpacing:1,marginBottom:6}}>
                    ASSIGNED SWITCHES ({assigned.length})
                  </div>
                  {assigned.length > 0 && (
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                      {assigned.map(d => (
                        <div key={d.id} style={{backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",borderRadius:4,padding:"2px 6px 2px 8px",display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                          <span style={{color:"#7dd3fc"}}>{d.sys_name || d.ip}</span>
                          <span style={{color:"#334155",fontSize:10}}>{d.ip}</span>
                          <button onClick={() => unassignDevice(d.id)} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:"0 2px",fontSize:11,lineHeight:1}} title="Unassign">x</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{display:"flex",gap:4}}>
                    <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sm.id]:e.target.value}))}
                      style={{flex:1,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:4,padding:"4px 6px",color:selVal?"#e2e8f0":"#475569",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                      <option value="">-- Assign switch --</option>
                      {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                    </select>
                    <button onClick={() => assignDevice(sm.id)} disabled={!selVal}
                      style={{backgroundColor:selVal?"#083344":"#0a0e18",border:"1px solid #164e63",color:selVal?"#22d3ee":"#1e3a5f",borderRadius:4,padding:"4px 10px",cursor:selVal?"pointer":"not-allowed",fontFamily:"'Inter', system-ui, sans-serif",fontSize:10}}>
                      Assign
                    </button>
                  </div>
                </div>
                <div style={{display:"flex",gap:5,justifyContent:"flex-end",marginTop:8}}>
                  <button onClick={() => startEdit(sm)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
                  {confirmDeleteId === sm.id ? (
                    <span style={{display:"flex",gap:4}}>
                      <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(sm.id)}>Confirm</button>
                      <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => remove(sm.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}

export default ModelsTabContent;
```

---

## Summary of Changes Per File

### SettingsPage.jsx (2 changes)
1. Expand `+ New Entry` button condition to include `racks`, `classes`, `models` tabs
2. Pass `newEntryTrigger` prop to `RacksTabContent`, `ClassesTabContent`, `ModelsTabContent`
3. Add `useEffect` to reset `newEntryTrigger` on tab change

### RacksTab.jsx (full rewrite)
1. Accept `newEntryTrigger` prop
2. Replace `editId` with `editState = { id, open }`
3. Add `startNew()` function
4. Update `resetForm()`, `startEdit()`, `submit()` to use `editState`
5. Update input styling: `bg #0c0f18`, `borderRadius 5`, `lineHeight 1.3`, `userSelect:"none"` on labels
6. Replace inline form with modal overlay (position:fixed, backdrop, centered, 560px, borderRadius 12)
7. Convert vertical stack listing to card grid (`repeat(auto-fill, minmax(300px, 1fr))`)
8. Move Edit/Delete buttons to bottom-right of card (matching CredentialsTab)
9. Update root container to `{flex:1, overflowY:"auto", paddingTop:20}` (matching CredentialsTab)
10. Device assignment section stays in cards (not in modal)

### SwitchClassesTab.jsx (full rewrite)
1. Accept `newEntryTrigger` prop
2. Replace `editId` with `editState = { id, open }`
3. Add `startNew()` function
4. Update `resetForm()`, `startEdit()`, `submit()` to use `editState`
5. Update input styling to match CredentialsTab
6. Replace inline form with modal overlay (color picker + allow_outside_rack checkbox stay in modal)
7. Convert vertical stack listing to card grid
8. Preserve: color accent bar, color dot, "Outside allowed"/"Rack required" badge on cards
9. Move Edit/Delete buttons to bottom-right of card
10. Device assignment section stays in cards

### SwitchModelsTab.jsx (full rewrite)
1. Accept `newEntryTrigger` prop
2. Replace `editId` with `editState = { id, open }`
3. Add `startNew()` function
4. Update `resetForm()`, `startEdit()`, `submit()` to use `editState`
5. Update input styling to match CredentialsTab
6. Replace inline form with modal overlay (cutoff toggle + input stay in modal)
7. Convert vertical stack listing to card grid
8. Preserve: cyan accent bar, ports/row badge, total ports badge on cards
9. Move Edit/Delete buttons to bottom-right of card
10. Device assignment section stays in cards

---

## What Stays in Cards (NOT in modal)
- Device assignment dropdown + Assign button
- Assigned switches chips with unassign button
- Edit / Delete action buttons
- Tab-specific display badges (rack room, class color dot, outside-rack badge, ports/row badge)

## What Goes in Modal (NOT in cards)
- **Racks**: Label, Room, Description
- **Classes**: Label, Color picker, Description, Allow outside rack checkbox
- **Models**: Name, Ports per row, Total ports cutoff (toggle + input), Description
