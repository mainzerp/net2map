import { useState, useEffect } from "react";
import { api, extractErrorMessage } from "../../api";
import type { SwitchClass, TopologyNode } from "../../types";

// ── ClassesTabContent ────────────────────────────────────────────────────────
interface ClassForm {
  label: string;
  description: string;
  color: string;
  allow_outside_rack: boolean;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface ClassesTabContentProps {
  newEntryTrigger: number;
}

const EMPTY_CLASS_FORM: ClassForm = { label: "", description: "", color: "#3b82f6", allow_outside_rack: false };

function ClassesTabContent({ newEntryTrigger }: ClassesTabContentProps) {
  const [classes, setClasses]   = useState<SwitchClass[]>([]);
  const [devices, setDevices]   = useState<TopologyNode[]>([]);
  const [loading, setLoading]   = useState<boolean>(true);
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm]         = useState<ClassForm>({ ...EMPTY_CLASS_FORM });
  const [err, setErr]           = useState<string>("");
  const [assignSel, setAssignSel] = useState<Record<number, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const refreshAll = () => {
    setLoading(true);
    Promise.allSettled([api.get("/api/switch-classes"), api.get("/api/devices?role=network")])
      .then(([classesRes, topoRes]) => {
        if (classesRes.status === "fulfilled") setClasses(classesRes.value);
        else setClasses([]);
        if (topoRes.status === "fulfilled") setDevices(topoRes.value || []);
        else setDevices([]);
        setLoading(false);
      });
  };
  useEffect(() => { refreshAll(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (sc: SwitchClass) => {
    setEditState({ id: sc.id, open: true });
    setForm({ label: sc.label, description: sc.description ?? "", color: sc.color, allow_outside_rack: !!sc.allow_outside_rack });
    setErr("");
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.label.trim()) { setErr("Label is required"); return; }
      if (editState.id) { await api.put(`/api/switch-classes/${editState.id}`, form); }
      else {
        const r = await api.post("/api/switch-classes", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refreshAll();
    } catch (ex) { setErr(extractErrorMessage(ex)); }
  };

  const remove = (id: number) => setConfirmDeleteId(id);
  const removeConfirmed = async (id: number) => {
    await api.del(`/api/switch-classes/${id}`); setConfirmDeleteId(null); refreshAll();
  };

  const assignDevice = async (classId: number) => {
    const devId = assignSel[classId];
    if (!devId) return;
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: classId });
      api.invalidate("/api/topology", "/api/devices?role=network", "/api/credentials");
      setAssignSel(prev => ({ ...prev, [classId]: "" }));
      refreshAll();
    } catch (ex) { setErr(extractErrorMessage(ex)); }
  };

  const unassignDevice = async (devId: number) => {
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: null });
      api.invalidate("/api/topology", "/api/devices?role=network", "/api/credentials");
      refreshAll();
    } catch (ex) { setErr(extractErrorMessage(ex)); }
  };

  const inp: React.CSSProperties = { backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5, color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%" };
  const lbl: React.CSSProperties = { fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" };

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>

      {/* Modal overlay for new / edit form */}
      {editState.open && (
        <div
          onClick={(e: React.MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) resetForm(); }}
          style={{
            position:"fixed", inset:0, zIndex:200,
            backgroundColor:"rgba(2,8,23,0.75)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}
        >
          <form onSubmit={submit} style={{
            width:480, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
            padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,fontWeight:700,letterSpacing:1}}>
                {editState.id ? "EDIT CLASS" : "NEW CLASS"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>{"\u2715"}</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,alignItems:"end"}}>
              <div><label style={lbl}>Label</label>
                <input required style={inp} value={form.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Top of Rack" /></div>
              <div><label style={lbl}>Color</label>
                <input type="color" value={form.color} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({...f, color:e.target.value}))}
                  style={{ width:40, height:29, padding:2, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5, cursor:"pointer" }} /></div>
            </div>
            <div style={{marginTop:8}}><label style={lbl}>Description</label>
              <input style={inp} value={form.description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" /></div>
            <label style={{ display:"flex", alignItems:"center", gap:6, color:"#94a3b8", fontSize:11, cursor:"pointer", marginTop:8 }}>
              <input type="checkbox" checked={!!form.allow_outside_rack} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, allow_outside_rack: e.target.checked }))} />
              Allow outside rack placement
            </label>
            {err && <div style={{ color:"#f87171", fontSize:11, marginTop:8 }}>{err}</div>}
            <div style={{ display:"flex", gap:8, marginTop:14 }}>
              <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
                {editState.id ? "Save" : "Create class"}
              </button>
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Card grid listing */}
      {loading ? (
        <div style={{ color:"#475569", fontSize:11 }}>Loading...</div>
      ) : classes.length === 0 ? (
        <div style={{ color:"#475569", fontSize:11, textAlign:"center", marginTop:20 }}>No classes defined yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(300px, 1fr))",gap:8}}>
          {classes.map(sc => {
            const assigned  = devices.filter(d => d.class_id === sc.id);
            const available = devices.filter(d => d.class_id == null && !d.ignored);
            const selVal    = assignSel[sc.id] || "";
            return (
              <div key={sc.id} style={{ display:"flex", flexDirection:"column", padding:"10px 12px", backgroundColor:"#0a0e18", border:`1px solid ${sc.color}44`, borderRadius:8, position:"relative", overflow:"hidden" }}>
                <div style={{ position:"absolute", top:0, left:0, width:3, bottom:0, backgroundColor:sc.color, borderRadius:"8px 0 0 8px" }} />
                <div style={{ marginLeft:12 }}>
                  <div style={{ display:"flex", alignItems:"flex-start" }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <div style={{ width:9, height:9, borderRadius:"50%", backgroundColor:sc.color, flexShrink:0 }} />
                        <span style={{ color:"#e2e8f0", fontWeight:600, fontSize:13 }}>{sc.label}</span>
                        <span style={{
                          fontSize:10, padding:"1px 6px", borderRadius:4,
                          border:`1px solid ${sc.allow_outside_rack ? "#14532d" : "#1e293b"}`,
                          backgroundColor: sc.allow_outside_rack ? "#052e16" : "#0a0e18",
                          color: sc.allow_outside_rack ? "#4ade80" : "#64748b",
                        }}>
                          {sc.allow_outside_rack ? "Outside allowed" : "Rack required"}
                        </span>
                      </div>
                      {sc.description && <div style={{ color:"#475569", fontSize:10, marginTop:2, marginLeft:17 }}>{sc.description}</div>}
                    </div>
                    <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                      <button onClick={() => startEdit(sc)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>
                      {confirmDeleteId === sc.id ? (
                        <span style={{display:"flex",gap:4}}>
                          <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>removeConfirmed(sc.id)}>Confirm</button>
                          <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button onClick={() => remove(sc.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
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
                      <select value={selVal} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAssignSel(p => ({...p, [sc.id]:e.target.value}))}
                        style={{ flex:1, backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"4px 6px", color:selVal?"#e2e8f0":"#475569", fontFamily:"'Inter', system-ui, sans-serif", fontSize:10 }}>
                        <option value="">-- Assign switch --</option>
                        {available.map(d => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
                      </select>
                      <button onClick={() => assignDevice(sc.id)} disabled={!selVal}
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
      )}
    </div>
  );
}

export default ClassesTabContent;
