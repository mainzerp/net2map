import { useState, useEffect } from "react";
import { api } from "../../api.js";

// ── RacksTabContent ──────────────────────────────────────────────────────────
const EMPTY_RACK_FORM = { label: "", room: "", description: "" };

function RacksTabContent() {
  const [racks, setRacks]       = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState({ ...EMPTY_RACK_FORM });
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

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

  const resetForm = () => { setForm({ ...EMPTY_RACK_FORM }); setEditId(null); setErr(""); };
  const startEdit = (r) => { setEditId(r.id); setForm({ label: r.label, room: r.room, description: r.description }); setErr(""); };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.label.trim()) { setErr("Label is required"); return; }
      if (editId) { await api.put(`/api/racks/${editId}`, form); }
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

  const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
  const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
  const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, overflowY:"auto", paddingTop:20, flex:1 }}>
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

      {loading ? (
        <div style={{ color:"#475569", fontSize:11 }}>Loading...</div>
      ) : racks.length === 0 ? (
        <div style={{ color:"#475569", fontSize:11, textAlign:"center", marginTop:20 }}>No racks defined yet</div>
      ) : racks.map(rack => {
        const assigned  = devices.filter(d => d.rack_id === rack.id);
        const available = devices.filter(d => d.rack_id == null);
        const selVal    = assignSel[rack.id] || "";
        return (
          <div key={rack.id} style={{ backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ display:"flex", alignItems:"flex-start" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:"#e2e8f0", fontWeight:600, fontSize:13 }}>{rack.label}</div>
                {(rack.room || rack.description) && (
                  <div style={{ color:"#475569", fontSize:10, marginTop:2 }}>
                    {rack.room}{rack.room && rack.description ? " - " : ""}{rack.description}
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                <button onClick={() => startEdit(rack)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>
                {confirmDeleteId === rack.id ? (
                  <span style={{display:"flex",gap:4}}>
                    <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>removeConfirmed(rack.id)}>Confirm</button>
                    <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => remove(rack.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
                )}
              </div>
            </div>
            <div style={{ marginTop:10, borderTop:"1px solid #0f172a", paddingTop:8 }}>
              <div style={{ color:"#475569", fontSize:10, letterSpacing:1, marginBottom:6 }}>
                ASSIGNED SWITCHES ({assigned.length})
              </div>
              {assigned.length > 0 && (
                <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:8 }}>
                  {assigned.map(d => (
                    <div key={d.id} style={{ backgroundColor:"#0c1a2e", border:"1px solid #1e3a5f", borderRadius:4, padding:"2px 6px 2px 8px", display:"flex", alignItems:"center", gap:4, fontSize:10 }}>
                      <span style={{ color:"#7dd3fc" }}>{d.sys_name || d.ip}</span>
                      <span style={{ color:"#334155", fontSize:10 }}>{d.ip}</span>
                      <button onClick={() => unassignDevice(d.id)} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", padding:"0 2px", fontSize:11, lineHeight:1 }} title="Unassign">x</button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display:"flex", gap:4 }}>
                <select value={selVal} onChange={e => setAssignSel(p => ({...p, [rack.id]:e.target.value}))}
                  style={{ flex:1, backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"4px 6px", color:selVal?"#e2e8f0":"#475569", fontFamily:"'Inter', system-ui, sans-serif", fontSize:10 }}>
                  <option value="">-- Assign switch --</option>
                  {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                </select>
                <button onClick={() => assignDevice(rack.id)} disabled={!selVal}
                  style={{ backgroundColor:selVal?"#083344":"#0a0e18", border:"1px solid #164e63", color:selVal?"#22d3ee":"#1e3a5f", borderRadius:4, padding:"4px 10px", cursor:selVal?"pointer":"not-allowed", fontFamily:"'Inter', system-ui, sans-serif", fontSize:10 }}>
                  Assign
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default RacksTabContent;
