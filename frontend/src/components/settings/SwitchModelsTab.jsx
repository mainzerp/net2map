import { useState, useEffect } from "react";
import { api } from "../../api.js";

// ── ModelsTabContent ────────────────────────────────────────────────────────
const EMPTY_MODEL_FORM = { name: "", ports_per_row: 24, total_ports: "", description: "" };

function ModelsTabContent() {
  const [models, setModels]     = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState({ ...EMPTY_MODEL_FORM });
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

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

  const resetForm = () => { setForm({ ...EMPTY_MODEL_FORM }); setEditId(null); setErr(""); };
  const startEdit = (sm) => {
    setEditId(sm.id);
    setForm({ name: sm.name, ports_per_row: sm.ports_per_row, total_ports: sm.total_ports ?? "", description: sm.description });
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
        total_ports: form.total_ports !== "" ? parseInt(form.total_ports, 10) || null : null,
        description: form.description,
      };
      if (editId) { await api.put(`/api/switch-models/${editId}`, payload); }
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

  const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
  const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
  const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, overflowY:"auto", paddingTop:20, flex:1 }}>
      <form onSubmit={submit} style={{ backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:8, padding:14, display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:4 }}>
          {editId ? "EDIT MODEL" : "NEW MODEL"}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <div style={{ flex:2 }}>
            <label style={LBL}>Name</label>
            <input required style={INPUT} value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} placeholder="e.g. Aruba CX 6300M-48" />
          </div>
          <div style={{ flex:1 }}>
            <label style={LBL}>Ports per row</label>
            <input type="number" min="1" max="96" style={INPUT} value={form.ports_per_row} onChange={e => setForm(f => ({...f, ports_per_row:e.target.value}))} />
          </div>
          <div style={{ flex:1 }}>
            <label style={LBL}>Total ports</label>
            <input type="number" min="0" style={INPUT} value={form.total_ports} onChange={e => setForm(f => ({...f, total_ports:e.target.value}))} placeholder="optional" />
          </div>
        </div>
        <div>
          <label style={LBL}>Description</label>
          <input style={INPUT} value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" />
        </div>
        {err && <div style={{ color:"#f87171", fontSize:11 }}>{err}</div>}
        <div style={{ display:"flex", gap:6 }}>
          <button type="submit" style={{ ...BTNP, flex:1 }}>{editId ? "Save" : "Create model"}</button>
          {editId && <button type="button" onClick={resetForm} style={{ backgroundColor:"transparent", border:"1px solid #1e293b", color:"#64748b", borderRadius:6, padding:"6px 12px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11 }}>Cancel</button>}
        </div>
      </form>

      {loading ? (
        <div style={{ color:"#475569", fontSize:11 }}>Loading...</div>
      ) : models.length === 0 ? (
        <div style={{ color:"#475569", fontSize:11, textAlign:"center", marginTop:20 }}>No models defined yet</div>
      ) : models.map(sm => {
        const assigned  = devices.filter(d => d.model_id === sm.id);
        const available = devices.filter(d => d.model_id == null && (d.ports || []).length > 0);
        const selVal    = assignSel[sm.id] || "";
        return (
          <div key={sm.id} style={{ backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:8, padding:"12px 14px", position:"relative", overflow:"hidden" }}>
            <div style={{ position:"absolute", top:0, left:0, width:3, bottom:0, backgroundColor:"#22d3ee", borderRadius:"8px 0 0 8px" }} />
            <div style={{ marginLeft:12 }}>
              <div style={{ display:"flex", alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ color:"#e2e8f0", fontWeight:600, fontSize:13 }}>{sm.name}</span>
                    <span style={{ color:"#22d3ee", fontSize:10, backgroundColor:"#083344", padding:"1px 6px", borderRadius:3, border:"1px solid #164e63" }}>
                      {sm.ports_per_row} ports/row
                    </span>
                    {sm.total_ports != null && (
                      <span style={{ color:"#64748b", fontSize:10 }}>{sm.total_ports} total</span>
                    )}
                  </div>
                  {sm.description && <div style={{ color:"#475569", fontSize:10, marginTop:2 }}>{sm.description}</div>}
                </div>
                <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                  <button onClick={() => startEdit(sm)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>
                  {confirmDeleteId === sm.id ? (
                    <span style={{display:"flex",gap:4}}>
                      <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>removeConfirmed(sm.id)}>Confirm</button>
                      <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => remove(sm.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
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
                  <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sm.id]:e.target.value}))}
                    style={{ flex:1, backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"4px 6px", color:selVal?"#e2e8f0":"#475569", fontFamily:"'Inter', system-ui, sans-serif", fontSize:10 }}>
                    <option value="">-- Assign switch --</option>
                    {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                  </select>
                  <button onClick={() => assignDevice(sm.id)} disabled={!selVal}
                    style={{ backgroundColor:selVal?"#083344":"#0a0e18", border:"1px solid #164e63", color:selVal?"#22d3ee":"#1e3a5f", borderRadius:4, padding:"4px 10px", cursor:selVal?"pointer":"not-allowed", fontFamily:"'Inter', system-ui, sans-serif", fontSize:10 }}>
                    Assign
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ModelsTabContent;
