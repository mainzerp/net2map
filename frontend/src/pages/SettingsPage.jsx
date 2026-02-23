import { useState, useEffect, useMemo, useRef } from "react";
import { api, API, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../api.js";


// ── MapSettingsTabContent ───────────────────────────────────────────────────
function MapSettingsTabContent({ url, opacity, scale, fileRef, onUpload, onRemove, onChangeOpacity, onChangeScale }) {
  const btnStyle = {
    border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
    borderRadius:6, padding:"6px 14px", cursor:"pointer",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
  };
  const labelStyle = { color:"#94a3b8", fontSize:11, fontFamily:"'Inter', system-ui, sans-serif" };
  const valStyle   = { color:"#64748b", fontSize:11, fontFamily:"monospace", minWidth:36 };

  return (
    <div style={{paddingTop:20, display:"flex", flexDirection:"column", gap:20, width:"100%"}}>
      <div style={{backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:10, padding:16, width:"100%", boxSizing:"border-box"}}>
        <div style={{...labelStyle, fontWeight:700, marginBottom:10}}>Background Image</div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
            onChange={e => { if (e.target.files[0]) { onUpload(e.target.files[0]); e.target.value = ""; } }}/>
          <button onClick={() => fileRef.current?.click()} style={btnStyle}>
            {url ? "Replace image" : "Upload image"}
          </button>
          {url && (
            <button onClick={onRemove}
              style={{...btnStyle, border:"1px solid #7f1d1d", background:"#1c1917", color:"#f87171"}}>
              Remove
            </button>
          )}
        </div>
        {url && (
          <div style={{marginTop:12, borderRadius:8, border:"1px solid #1e293b", overflow:"hidden", maxWidth:400}}>
            <img src={url} alt="Background preview" style={{display:"block", width:"100%", opacity:0.8}}/>
          </div>
        )}
      </div>
      {url && (
        <div style={{marginTop:14}}>
          <div style={{...labelStyle, marginBottom:6}}>Opacity</div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <input type="range" min="0.05" max="1" step="0.05" value={opacity}
              onChange={e => onChangeOpacity(parseFloat(e.target.value))}
              style={{width:200, accentColor:"#22d3ee"}}/>
            <span style={valStyle}>{Math.round(opacity*100)}%</span>
          </div>
        </div>
      )}
      {url && (
        <div style={{marginTop:14}}>
          <div style={{...labelStyle, marginBottom:6}}>Image Zoom</div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <input type="range" min="0.1" max="5" step="0.1" value={scale}
              onChange={e => onChangeScale(parseFloat(e.target.value))}
              style={{width:200, accentColor:"#22d3ee"}}/>
            <span style={valStyle}>{Math.round(scale*100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}


// ── SnmpProfilesTabContent ──────────────────────────────────────────────────
const EMPTY_PROFILE_FORM = {
  label:"",
  snmp_version:"v2c", community:"public",
  v3_security_level:"authPriv", v3_username:"",
  v3_auth_protocol:"SHA-256", v3_auth_password:"",
  v3_priv_protocol:"AES-128", v3_priv_password:"",
};

function SnmpProfilesTabContent({ profiles, loading, onChanged }) {
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState({ ...EMPTY_PROFILE_FORM });
  const [err, setErr]           = useState("");
  const formRef = useRef(null);

  const resetForm = () => { setForm({ ...EMPTY_PROFILE_FORM }); setEditId(null); setErr(""); };
  const startEdit = (p) => { setEditId(p.id); setForm({
    label:p.label, snmp_version:p.snmp_version, community:p.community,
    v3_security_level:p.v3_security_level, v3_username:p.v3_username,
    v3_auth_protocol:p.v3_auth_protocol, v3_auth_password:p.v3_auth_password,
    v3_priv_protocol:p.v3_priv_protocol, v3_priv_password:p.v3_priv_password,
  }); setErr(""); setTimeout(() => formRef.current?.scrollIntoView({ behavior:"smooth", block:"start" }), 0); };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (editId) { await api.put(`/api/snmp-profiles/${editId}`, form); }
      else {
        const r = await api.post("/api/snmp-profiles", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); onChanged();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = async (id) => {
    if (!confirm("Delete profile? Linked credentials will be unlinked.")) return;
    await api.del(`/api/snmp-profiles/${id}`); onChanged();
  };

  const F = form;
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const isV3 = F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";

  const inp = { backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5, color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%" };
  const sel = { ...inp, cursor:"pointer" };

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>
        <form ref={formRef} onSubmit={submit} style={{marginBottom:18,padding:"14px",backgroundColor:"#0a0e18",border:"1px solid #1e293b",borderRadius:10}}>
          <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1,marginBottom:12}}>{editId?"EDIT":"NEW PROFILE"}</div>
          <div style={{marginBottom:8}}>
            <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Profile name *
              <input required value={F.label} onChange={e=>set("label",e.target.value)} placeholder="SNMPv3 Aruba Core" style={{...inp,marginTop:3}}/>
            </label>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>SNMP Version</div>
            <div style={{display:"flex",gap:6}}>
              {["v2c","v3"].map(v=>(
                <button key={v} type="button" onClick={()=>set("snmp_version",v)} style={{padding:"4px 14px",borderRadius:5,fontSize:11,cursor:"pointer",fontFamily:"'Inter', system-ui, sans-serif",fontWeight:F.snmp_version===v?600:400,backgroundColor:F.snmp_version===v?"#083344":"transparent",border:`1px solid ${F.snmp_version===v?"#164e63":"#1e293b"}`,color:F.snmp_version===v?"#22d3ee":"#64748b"}}>{v}</button>
              ))}
            </div>
          </div>
          {!isV3 && <div style={{marginBottom:8}}><label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Community String *<input required value={F.community} onChange={e=>set("community",e.target.value)} placeholder="public" style={{...inp,marginTop:3}}/></label></div>}
          {isV3 && (
            <div style={{padding:"10px 12px",borderRadius:8,backgroundColor:"#0c1220",border:"1px solid #1e3a52",marginBottom:8,display:"flex",flexDirection:"column",gap:8}}>
              <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Security Level
                <select value={F.v3_security_level} onChange={e=>set("v3_security_level",e.target.value)} style={{...sel,marginTop:3}}>
                  {SEC_LEVELS.map(l=><option key={l}>{l}</option>)}
                </select>
              </label>
              <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Username
                <input value={F.v3_username} onChange={e=>set("v3_username",e.target.value)} style={{...inp,marginTop:3}}/>
              </label>
              {needAuth && <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Auth Protocol
                    <select value={F.v3_auth_protocol} onChange={e=>set("v3_auth_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                      {AUTH_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                    </select>
                  </label>
                  <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Auth Password
                    <input type="password" value={F.v3_auth_password} onChange={e=>set("v3_auth_password",e.target.value)} style={{...inp,marginTop:3}}/>
                  </label>
                </div>
              </>}
              {needPriv && <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Priv Protocol
                    <select value={F.v3_priv_protocol} onChange={e=>set("v3_priv_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                      {PRIV_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                    </select>
                  </label>
                  <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Priv Password
                    <input type="password" value={F.v3_priv_password} onChange={e=>set("v3_priv_password",e.target.value)} style={{...inp,marginTop:3}}/>
                  </label>
                </div>
              </>}
            </div>
          )}
          {err && <div style={{color:"#f87171",fontSize:11,marginBottom:8}}>{err}</div>}
          <div style={{display:"flex",gap:6}}>
            <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"6px",cursor:"pointer",fontFamily:"'Inter', system-ui, sans-serif",fontSize:11,fontWeight:600}}>{editId?"Save":"Create profile"}</button>
            {editId && <button type="button" onClick={resetForm} style={{backgroundColor:"transparent",border:"1px solid #1e293b",color:"#64748b",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontFamily:"'Inter', system-ui, sans-serif",fontSize:11}}>Cancel</button>}
          </div>
        </form>
        {loading ? <div style={{color:"#64748b",fontSize:11}}>Loading...</div> : profiles.length === 0 ? (
          <div style={{color:"#64748b",fontSize:11,textAlign:"center",marginTop:20}}>No profiles defined yet</div>
        ) : profiles.map(p => (
          <div key={p.id} style={{backgroundColor:"#0a0e18",border:"1px solid #1e293b",borderRadius:8,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"flex-start",gap:10}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{p.label}</div>
              <div style={{color:"#94a3b8",fontSize:10,marginTop:2}}>
                {p.snmp_version === "v3" ? `v3 - ${p.v3_security_level} - ${p.v3_username || "-"}` : `v2c - ${p.community}`}
              </div>
            </div>
            <button onClick={()=>startEdit(p)} style={{background:"none",border:"1px solid #1e293b",color:"#94a3b8",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}}>Edit</button>
            <button onClick={()=>remove(p.id)} style={{background:"none",border:"1px solid #450a0a",color:"#7f1d1d",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}}>X</button>
          </div>
        ))}
      </div>
  );
}


// ── CredentialsTabContent ──────────────────────────────────────────────────
const EMPTY_FORM = {
  label:"", ip:"", snmp_port:161, location:"", enabled:true,
  profile_id: null,
  rack_id: null,
  class_id: null,
  vendor:"generic", model:"",
  snmp_version:"v2c", community:"public",
  v3_security_level:"authPriv", v3_username:"",
  v3_auth_protocol:"SHA-256", v3_auth_password:"",
  v3_priv_protocol:"AES-128", v3_priv_password:"",
};

function CredentialsTabContent({ profiles }) {
  const [creds, setCreds]       = useState([]);
  const [devices, setDevices]   = useState([]);
  const [racks, setRacks]       = useState([]);
  const [classes, setClasses]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editState, setEditState] = useState({ id: null, top: 80, left: 540 });
  const [editFormHeight, setEditFormHeight] = useState(0);
  const [form, setForm]         = useState({ ...EMPTY_FORM });
  const [err, setErr]           = useState("");
  const formRef = useRef(null);
  const rowRefs = useRef({});

  const refresh = () => {
    setLoading(true);
    Promise.all([
      api.get("/api/credentials"),
      api.get("/api/topology"),
      api.get("/api/racks"),
      api.get("/api/switch-classes"),
    ])
      .then(([c, t, r, cl]) => { setCreds(c); setDevices(t.nodes || []); setRacks(r || []); setClasses(cl || []); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_FORM }); setEditState(s => ({ ...s, id: null })); setErr(""); };

  const startEdit = (c, e) => {
    const rect = rowRefs.current[c.id]?.getBoundingClientRect?.() || e?.currentTarget?.getBoundingClientRect?.();
    if (rect) {
      if (!editState.id) {
        const measuredHeight = formRef.current?.offsetHeight;
        if (measuredHeight) setEditFormHeight(measuredHeight);
      }
      const nextTop = Math.max(64, Math.floor(rect.top));
      const gap = 12;
      let left = Math.floor(rect.right + gap);
      setEditState({ id: c.id, top: nextTop, left });
    } else {
      setEditState(s => ({ ...s, id: c.id }));
    }
    setForm({
      label:c.label, ip:c.ip, snmp_port:c.snmp_port, location:c.location, enabled:c.enabled,
      profile_id: c.profile_id ?? null,
      rack_id: c.rack_id ?? null,
      class_id: c.class_id ?? null,
      vendor: c.vendor ?? "generic", model: c.model ?? "",
      snmp_version:c.snmp_version, community:c.community,
      v3_security_level:c.v3_security_level, v3_username:c.v3_username,
      v3_auth_protocol:c.v3_auth_protocol,   v3_auth_password:c.v3_auth_password,
      v3_priv_protocol:c.v3_priv_protocol,   v3_priv_password:c.v3_priv_password,
    });
    setErr("");
  };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (editState.id) { await api.put(`/api/credentials/${editState.id}`, form); }
      else {
        const r = await api.post("/api/credentials", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refresh();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = async (id) => {
    if (!confirm("Delete credential?")) return;
    await api.del(`/api/credentials/${id}`); refresh();
  };

  const F = form;
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const isV3 = F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";

  const inp = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
    color:"#e2e8f0", padding:"5px 8px",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
  };
  const sel = { ...inp, cursor:"pointer" };
  const lbl = () => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });

  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20}}>
        {editState.id && editFormHeight > 0 && (
          <div style={{
            height:editFormHeight, marginBottom:18,
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:10,
            padding:"14px", boxSizing:"border-box",
            overflow:"auto",
          }}>
            <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1,marginBottom:8}}>NEW ENTRY</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>Label *</div>
                <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>Core Switch RZ-01</div>
              </div>
              <div>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>IP address *</div>
                <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>192.168.1.1</div>
              </div>
              <div>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>SNMP Port</div>
                <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>161</div>
              </div>
              <div>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>Location (optional)</div>
                <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>Rack A / RZ-01</div>
              </div>
            </div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>Credential profile (optional)</div>
              <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>-- No profile (manual settings) --</div>
            </div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>SNMP Version</div>
              <div style={{display:"flex",gap:6}}>
                <div style={{padding:"4px 14px",borderRadius:5,fontSize:11,border:"1px solid #164e63",backgroundColor:"#083344",color:"#22d3ee"}}>v2c</div>
                <div style={{padding:"4px 14px",borderRadius:5,fontSize:11,border:"1px solid #1e293b",backgroundColor:"transparent",color:"#64748b"}}>v3</div>
              </div>
            </div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:10,color:"#94a3b8",marginBottom:3}}>Community String *</div>
              <div style={{height:30,border:"1px solid #1e293b",borderRadius:5,backgroundColor:"#0c0f18",padding:"6px 8px",color:"#94a3b8",fontSize:11}}>public</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b",marginBottom:10}}>
              <div style={{width:14,height:14,border:"1px solid #1e293b",borderRadius:3,backgroundColor:"#0c0f18"}} />
              Include in scan
            </div>
            <div style={{height:30,borderRadius:6,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:600}}>
              + Add
            </div>
          </div>
        )}
        <form ref={formRef} onSubmit={submit} style={{
          marginBottom: editState.id ? 0 : 18,padding:"14px",backgroundColor:"#0a0e18",border:"1px solid #1e293b",borderRadius:10,
          ...(editState.id ? {
            position:"fixed", left:editState.left, top:editState.top, width:540, zIndex:80,
            maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            boxShadow:"0 12px 30px rgba(0,0,0,0.45)",
          } : {}),
        }}>
          <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1,marginBottom:12}}>
            {editState.id ? "EDIT" : "NEW ENTRY"}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            <label style={lbl()}>Label *
              <input required value={F.label} onChange={e=>set("label",e.target.value)} placeholder="Core Switch RZ-01" style={{...inp,marginTop:3}}/>
            </label>
            <label style={lbl()}>IP address *
              <input required value={F.ip} onChange={e=>set("ip",e.target.value)} placeholder="192.168.1.1" style={{...inp,marginTop:3}}/>
            </label>
            <label style={lbl()}>SNMP Port
              <input type="number" value={F.snmp_port} onChange={e=>set("snmp_port",+e.target.value)} style={{...inp,marginTop:3}}/>
            </label>
            <label style={lbl()}>Location (optional)
              <input value={F.location} onChange={e=>set("location",e.target.value)} placeholder="Rack A / RZ-01" style={{...inp,marginTop:3}}/>
            </label>
            <label style={lbl()}>Vendor
              <select value={F.vendor || "generic"} onChange={e=>set("vendor", e.target.value)} style={{...sel,marginTop:3}}>
                <option value="aruba_cx">Aruba CX</option>
                <option value="fs">FS</option>
                <option value="unifi">UniFi</option>
                <option value="generic">Generic</option>
              </select>
            </label>
            <label style={lbl()}>Model
              <input value={F.model || ""} onChange={e=>set("model",e.target.value)} placeholder="e.g. UniFi USW-24" style={{...inp,marginTop:3}}/>
            </label>
            <label style={lbl()}>Rack (optional)
              <select value={F.rack_id ?? ""} onChange={e=>set("rack_id", e.target.value ? +e.target.value : null)} style={{...sel,marginTop:3}}>
                <option value="">-- No rack --</option>
                {racks.map(r=><option key={r.id} value={r.id}>{r.label}{r.room ? ` / ${r.room}` : ""}</option>)}
              </select>
            </label>
            <label style={lbl()}>Class (optional)
              <select value={F.class_id ?? ""} onChange={e=>set("class_id", e.target.value ? +e.target.value : null)} style={{...sel,marginTop:3}}>
                <option value="">-- No class --</option>
                {classes.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>Credential profile (optional)</div>
            <select
              value={F.profile_id ?? ""}
              onChange={e => set("profile_id", e.target.value ? +e.target.value : null)}
              style={{...sel}}
            >
              <option value="">-- No profile (manual settings) --</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label} - {p.snmp_version === "v3" ? `v3 / ${p.v3_security_level}` : `v2c / ${p.community}`}
                </option>
              ))}
            </select>
          </div>
          {F.profile_id == null && <>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>SNMP Version</div>
            <div style={{display:"flex",gap:6}}>
              {["v2c","v3"].map(v => (
                <button key={v} type="button" onClick={()=>set("snmp_version",v)} style={{
                  padding:"4px 14px", borderRadius:5, fontSize:11, cursor:"pointer",
                  fontFamily:"'Inter', system-ui, sans-serif", fontWeight: F.snmp_version===v ? 600 : 400,
                  backgroundColor: F.snmp_version===v ? "#083344" : "transparent",
                  border: `1px solid ${F.snmp_version===v ? "#164e63" : "#1e293b"}`,
                  color: F.snmp_version===v ? "#22d3ee" : "#64748b",
                }}>{v}</button>
              ))}
            </div>
          </div>
          {!isV3 && (
            <div style={{marginBottom:8}}>
              <label style={lbl()}>Community String *
                <input required value={F.community} onChange={e=>set("community",e.target.value)} placeholder="public" style={{...inp,marginTop:3}}/>
              </label>
            </div>
          )}
          {isV3 && (
            <div style={{
              padding:"10px 12px", borderRadius:8,
              backgroundColor:"#0c1220", border:"1px solid #1e3a52",
              marginBottom:8, display:"flex", flexDirection:"column", gap:8,
            }}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <label style={lbl()}>Username *
                  <input required={isV3} value={F.v3_username} onChange={e=>set("v3_username",e.target.value)} placeholder="netmonitor" style={{...inp,marginTop:3}}/>
                </label>
                <label style={lbl()}>Security Level
                  <select value={F.v3_security_level} onChange={e=>set("v3_security_level",e.target.value)} style={{...sel,marginTop:3}}>
                    {SEC_LEVELS.map(l=><option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
              </div>
              {needAuth && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <label style={lbl()}>Auth protocol
                    <select value={F.v3_auth_protocol} onChange={e=>set("v3_auth_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                      {AUTH_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                    </select>
                  </label>
                  <label style={lbl()}>Auth password *
                    <input required={needAuth} type="password" value={F.v3_auth_password} onChange={e=>set("v3_auth_password",e.target.value)} placeholder=">= 8 characters" style={{...inp,marginTop:3}}/>
                  </label>
                </div>
              )}
              {needPriv && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <label style={lbl()}>Priv protocol (encryption)
                    <select value={F.v3_priv_protocol} onChange={e=>set("v3_priv_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                      {PRIV_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                    </select>
                  </label>
                  <label style={lbl()}>Priv password *
                    <input required={needPriv} type="password" value={F.v3_priv_password} onChange={e=>set("v3_priv_password",e.target.value)} placeholder=">= 8 characters" style={{...inp,marginTop:3}}/>
                  </label>
                </div>
              )}
              <div style={{fontSize:10,color:"#64748b",lineHeight:1.6}}>
                {F.v3_security_level === "noAuthNoPriv" && "Warning: No auth / no encryption - for testing only"}
                {F.v3_security_level === "authNoPriv"   && "Warning: Authentication without encryption"}
                {F.v3_security_level === "authPriv"     && "OK: Authentication + encryption (recommended)"}
              </div>
            </div>
          )}
          </>}
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b",cursor:"pointer",marginBottom:12}}>
            <input type="checkbox" checked={F.enabled} onChange={e=>set("enabled",e.target.checked)}/> Include in scan
          </label>
          {err && <div style={{marginBottom:8,color:"#f87171",fontSize:10}}>{err}</div>}
          <div style={{display:"flex",gap:8}}>
            <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"7px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
              {editState.id ? "Save" : "+ Add"}
            </button>
            {editState.id && (
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            )}
          </div>
        </form>
        {loading ? (
          <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>Loading...</div>
        ) : creds.length === 0 ? (
          <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>No entries yet</div>
        ) : (
          creds.map(c => {
            const v3 = c.snmp_version === "v3";
            const assignedProfile = c.profile_id ? profiles.find(p => p.id === c.profile_id) : null;
            const matchedDevice = devices.find(d => d.ip === c.ip);
            return (
              <div key={c.id} data-cred-row={c.id} ref={el => { if (el) rowRefs.current[c.id] = el; }} style={{
                display:"flex", alignItems:"flex-start", justifyContent:"space-between",
                padding:"10px 12px", marginBottom:6,
                backgroundColor: editState.id === c.id ? "#0c1220" : "#0a0e18",
                border:`1px solid ${editState.id === c.id ? "#164e63" : (c.enabled ? "#1e293b" : "#0f172a")}`,
                borderRadius:8, opacity: c.enabled ? 1 : 0.5,
                boxShadow: editState.id === c.id ? "0 0 0 1px #083344" : "none",
              }}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:6,height:6,borderRadius:"50%",backgroundColor:c.enabled?"#22c55e":"#64748b",flexShrink:0}}/>
                    <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{c.label}</span>
                    <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:v3?"#1e0b3a":"#0a0e18",
                      border:`1px solid ${v3?"#6d28d9":"#1e293b"}`,
                      color:v3?"#a78bfa":"#64748b",
                    }}>{c.snmp_version}</span>
                    {v3 && <span style={{fontSize:10,color:"#94a3b8"}}>{c.v3_security_level}</span>}
                    {matchedDevice && <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:"#052e16",border:"1px solid #166534",color:"#4ade80",
                    }}>discovered</span>}
                  </div>
                  <div style={{color:"#64748b",fontSize:10,marginTop:3,paddingLeft:14}}>
                    {c.ip}:{c.snmp_port}
                    {assignedProfile
                      ? <> - <span style={{color:"#7dd3fc"}}>{assignedProfile.label}</span></>
                      : !v3
                        ? <> - community: <span style={{color:"#64748b"}}>{c.community}</span></>
                        : <> - user: <span style={{color:"#64748b"}}>{c.v3_username}</span> - {c.v3_auth_protocol}/{c.v3_priv_protocol}</>
                    }
                    {c.location && <> - {c.location}</>}
                    {matchedDevice && matchedDevice.model && <> - <span style={{color:"#64748b"}}>{matchedDevice.model}</span></>}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0,marginLeft:8}}>
                  <button onClick={(e) => startEdit(c, e)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
                  <button onClick={() => remove(c.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
                </div>
              </div>
            );
          })
        )}
        {(() => {
          const credIps = new Set(creds.map(c => c.ip));
          const unassigned = devices.filter(d => !credIps.has(d.ip));
          if (unassigned.length === 0) return null;
          return (
            <div style={{marginTop:20}}>
              <div style={{color:"#e2e8f0",fontSize:10,letterSpacing:2,marginBottom:10}}>
                DISCOVERED WITHOUT CREDENTIALS ({unassigned.length})
              </div>
              {unassigned.map(d => (
                <div key={d.id} style={{
                  display:"flex", alignItems:"flex-start", justifyContent:"space-between",
                  padding:"10px 12px", marginBottom:6,
                  backgroundColor:"#0a0e18", border:"1px solid #1e293b",
                  borderRadius:8,
                }}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:6,height:6,borderRadius:"50%",backgroundColor:"#eab308",flexShrink:0}}/>
                      <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{d.sys_name || d.ip}</span>
                      <span style={{
                        fontSize:10,padding:"1px 5px",borderRadius:3,
                        backgroundColor:"#422006",border:"1px solid #854d0e",color:"#fbbf24",
                      }}>unassigned</span>
                    </div>
                    <div style={{color:"#e2e8f0",fontSize:10,marginTop:3,paddingLeft:14}}>
                      {d.ip}
                      {d.vendor && <> - {d.vendor}</>}
                      {d.model && <> - {d.model}</>}
                      {d.ports && <> - {d.ports.filter(p => p.oper_status === 1).length}/{d.ports.length} ports</>}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setForm(f => ({ ...f, label: d.sys_name || d.ip, ip: d.ip, location: d.location || "", vendor: d.vendor || "generic", model: d.model || "" }));
                      setEditState(s => ({ ...s, id: null }));
                      setErr("");
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    style={{
                      background:"none",border:"1px solid #854d0e",color:"#fbbf24",
                      borderRadius:4,padding:"3px 10px",cursor:"pointer",fontSize:10,
                      fontFamily:"'Inter', system-ui, sans-serif",flexShrink:0,
                    }}
                  >+ Add credentials</button>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
  );
}


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

  const refreshAll = () => {
    setLoading(true);
    Promise.all([api.get("/api/racks"), api.get("/api/topology")])
      .then(([r, t]) => { setRacks(r); setDevices(t.nodes || []); setLoading(false); })
      .catch(() => setLoading(false));
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

  const remove = async (id) => {
    if (!confirm("Delete rack? All assignments will be removed.")) return;
    await api.del(`/api/racks/${id}`); refreshAll();
  };

  const assignDevice = async (rackId) => {
    const devId = assignSel[rackId];
    if (!devId) return;
    await api.patch(`/api/topology/devices/${devId}/meta`, { rack_id: rackId });
    setAssignSel(prev => ({ ...prev, [rackId]: "" }));
    refreshAll();
  };

  const unassignDevice = async (devId) => {
    await api.patch(`/api/topology/devices/${devId}/meta`, { rack_id: null });
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
        const available = devices.filter(d => d.rack_id !== rack.id);
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
                <button onClick={() => remove(rack.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
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


// ── ClassesTabContent ────────────────────────────────────────────────────────
const EMPTY_CLASS_FORM = { label: "", description: "", color: "#3b82f6" };

function ClassesTabContent() {
  const [classes, setClasses]   = useState([]);
  const [devices, setDevices]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState({ ...EMPTY_CLASS_FORM });
  const [err, setErr]           = useState("");
  const [assignSel, setAssignSel] = useState({});

  const refreshAll = () => {
    setLoading(true);
    Promise.all([api.get("/api/switch-classes"), api.get("/api/topology")])
      .then(([c, t]) => { setClasses(c); setDevices(t.nodes || []); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(() => { refreshAll(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditId(null); setErr(""); };
  const startEdit = (sc) => { setEditId(sc.id); setForm({ label: sc.label, description: sc.description, color: sc.color }); setErr(""); };

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try {
      if (!form.label.trim()) { setErr("Label is required"); return; }
      if (editId) { await api.put(`/api/switch-classes/${editId}`, form); }
      else {
        const r = await api.post("/api/switch-classes", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refreshAll();
    } catch (ex) { setErr(String(ex)); }
  };

  const remove = async (id) => {
    if (!confirm("Delete class? All assignments will be removed.")) return;
    await api.del(`/api/switch-classes/${id}`); refreshAll();
  };

  const assignDevice = async (classId) => {
    const devId = assignSel[classId];
    if (!devId) return;
    await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: classId });
    setAssignSel(prev => ({ ...prev, [classId]: "" }));
    refreshAll();
  };

  const unassignDevice = async (devId) => {
    await api.patch(`/api/topology/devices/${devId}/meta`, { class_id: null });
    refreshAll();
  };

  const INPUT = { width:"100%", backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, padding:"5px 8px", color:"#e2e8f0", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, boxSizing:"border-box" };
  const LBL   = { color:"#94a3b8", fontSize:10, marginBottom:3, display:"block" };
  const BTNP  = { backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee", borderRadius:6, padding:"6px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600 };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, overflowY:"auto", paddingTop:20, flex:1 }}>
      <form onSubmit={submit} style={{ backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:8, padding:14, display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:4 }}>
          {editId ? "EDIT CLASS" : "NEW CLASS"}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
          <div style={{ flex:1 }}>
            <label style={LBL}>Label</label>
            <input required style={INPUT} value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} placeholder="e.g. Top of Rack" />
          </div>
          <div>
            <label style={LBL}>Color</label>
            <input type="color" value={form.color} onChange={e => setForm(f => ({...f, color:e.target.value}))}
              style={{ width:40, height:29, padding:2, backgroundColor:"#020817", border:"1px solid #1e293b", borderRadius:4, cursor:"pointer" }} />
          </div>
        </div>
        <div><label style={LBL}>Description</label>
          <input style={INPUT} value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} placeholder="optional" /></div>
        {err && <div style={{ color:"#f87171", fontSize:11 }}>{err}</div>}
        <div style={{ display:"flex", gap:6 }}>
          <button type="submit" style={{ ...BTNP, flex:1 }}>{editId ? "Save" : "Create class"}</button>
          {editId && <button type="button" onClick={resetForm} style={{ backgroundColor:"transparent", border:"1px solid #1e293b", color:"#64748b", borderRadius:6, padding:"6px 12px", cursor:"pointer", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11 }}>Cancel</button>}
        </div>
      </form>

      {loading ? (
        <div style={{ color:"#475569", fontSize:11 }}>Loading...</div>
      ) : classes.length === 0 ? (
        <div style={{ color:"#475569", fontSize:11, textAlign:"center", marginTop:20 }}>No classes defined yet</div>
      ) : classes.map(sc => {
        const assigned  = devices.filter(d => d.class_id === sc.id);
        const available = devices.filter(d => d.class_id !== sc.id);
        const selVal    = assignSel[sc.id] || "";
        return (
          <div key={sc.id} style={{ backgroundColor:"#0a0e18", border:`1px solid ${sc.color}44`, borderRadius:8, padding:"12px 14px", position:"relative", overflow:"hidden" }}>
            <div style={{ position:"absolute", top:0, left:0, width:3, bottom:0, backgroundColor:sc.color, borderRadius:"8px 0 0 8px" }} />
            <div style={{ marginLeft:12 }}>
              <div style={{ display:"flex", alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:9, height:9, borderRadius:"50%", backgroundColor:sc.color, flexShrink:0 }} />
                    <span style={{ color:"#e2e8f0", fontWeight:600, fontSize:13 }}>{sc.label}</span>
                  </div>
                  {sc.description && <div style={{ color:"#475569", fontSize:10, marginTop:2, marginLeft:17 }}>{sc.description}</div>}
                </div>
                <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                  <button onClick={() => startEdit(sc)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>
                  <button onClick={() => remove(sc.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
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
                  <select value={selVal} onChange={e => setAssignSel(p => ({...p, [sc.id]:e.target.value}))}
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
  );
}


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

  const refreshAll = () => {
    setLoading(true);
    Promise.all([api.get("/api/switch-models"), api.get("/api/topology")])
      .then(([m, t]) => { setModels(m); setDevices(t.nodes || []); setLoading(false); })
      .catch(() => setLoading(false));
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

  const remove = async (id) => {
    if (!confirm("Delete model? All assignments will be removed.")) return;
    await api.del(`/api/switch-models/${id}`); refreshAll();
  };

  const assignDevice = async (modelId) => {
    const devId = assignSel[modelId];
    if (!devId) return;
    await api.patch(`/api/topology/devices/${devId}/meta`, { model_id: modelId });
    setAssignSel(prev => ({ ...prev, [modelId]: "" }));
    refreshAll();
  };

  const unassignDevice = async (devId) => {
    await api.patch(`/api/topology/devices/${devId}/meta`, { model_id: null });
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
        const available = devices.filter(d => d.model_id !== sm.id);
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
                  <button onClick={() => remove(sm.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
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


// ── EngineTabContent ────────────────────────────────────────────────────────
function EngineTabContent() {
  const [scanning, setScanning]     = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [history, setHistory]       = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [scanWorkers, setScanWorkers] = useState(4);
  const [snmpTimeout, setSnmpTimeout] = useState(3);
  const [snmpRetries, setSnmpRetries] = useState(1);
  const [discoveryIntervalSec, setDiscoveryIntervalSec] = useState(1800);
  const [portUpdateIntervalSec, setPortUpdateIntervalSec] = useState(30);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);

  // Discovery ranges state
  const [discoveryRanges, setDiscoveryRanges] = useState([]);
  const [rangesInput, setRangesInput] = useState("");
  const [rangesSaving, setRangesSaving] = useState(false);
  const [rangesError, setRangesError] = useState("");

  // Dry run state
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);

  const pollRef = useRef(null);

  useEffect(() => {
    Promise.all([api.get("/api/scan-settings"), api.get("/api/settings"), api.get("/api/discovery-ranges")])
      .then(([scanSettings, appSettings, rangesResp]) => {
        if (scanSettings?.max_workers != null) setScanWorkers(Number(scanSettings.max_workers));
        if (scanSettings?.snmp_timeout != null) setSnmpTimeout(Number(scanSettings.snmp_timeout));
        if (scanSettings?.snmp_retries != null) setSnmpRetries(Number(scanSettings.snmp_retries));

        const settingsList = Array.isArray(appSettings) ? appSettings : [];
        const discovery = settingsList.find(s => s.key === "discovery_interval_sec");
        const ports = settingsList.find(s => s.key === "port_update_interval_sec");
        if (discovery?.value != null) setDiscoveryIntervalSec(Number(discovery.value));
        if (ports?.value != null) setPortUpdateIntervalSec(Number(ports.value));

        const ranges = Array.isArray(rangesResp?.ranges) ? rangesResp.ranges : [];
        setDiscoveryRanges(ranges);
        setRangesInput(ranges.join("\n"));
      })
      .finally(() => setSettingsLoading(false));
  }, []);

  const loadHistory = () => {
    setHistoryLoading(true);
    api.get("/api/scan-runs?limit=20")
      .then(runs => setHistory(Array.isArray(runs) ? runs : []))
      .finally(() => setHistoryLoading(false));
  };

  useEffect(() => {
    loadHistory();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const saveScanSettings = async () => {
    setSettingsSaving(true);
    try {
      const payload = { 
        max_workers: Math.max(1, Math.min(128, Number(scanWorkers) || 1)),
        snmp_timeout: Math.max(1, Math.min(30, Number(snmpTimeout) || 3)),
        snmp_retries: Math.max(0, Math.min(10, Number(snmpRetries) || 1))
      };

      const nextDiscoveryInterval = Math.max(0, Math.min(86400, Number(discoveryIntervalSec) || 0));
      const nextPortsInterval = Math.max(0, Math.min(3600, Number(portUpdateIntervalSec) || 0));

      const result = await api.put("/api/scan-settings", payload);
      await api.put("/api/settings/discovery_interval_sec", { value: String(nextDiscoveryInterval) });
      await api.put("/api/settings/port_update_interval_sec", { value: String(nextPortsInterval) });

      if (result?.max_workers != null) setScanWorkers(Number(result.max_workers));
      if (result?.snmp_timeout != null) setSnmpTimeout(Number(result.snmp_timeout));
      if (result?.snmp_retries != null) setSnmpRetries(Number(result.snmp_retries));
      setDiscoveryIntervalSec(nextDiscoveryInterval);
      setPortUpdateIntervalSec(nextPortsInterval);
    } finally {
      setSettingsSaving(false);
    }
  };

  const saveDiscoveryRanges = async () => {
    setRangesError("");
    setRangesSaving(true);
    try {
      const lines = rangesInput
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
      const resp = await api.put("/api/discovery-ranges", { ranges: lines });
      if (resp?.detail) {
        setRangesError(typeof resp.detail === "string" ? resp.detail : JSON.stringify(resp.detail));
        return;
      }
      const saved = Array.isArray(resp?.ranges) ? resp.ranges : lines;
      setDiscoveryRanges(saved);
      setRangesInput(saved.join("\n"));
    } catch (ex) {
      setRangesError(String(ex));
    } finally {
      setRangesSaving(false);
    }
  };

  const removeRange = (idx) => {
    const next = discoveryRanges.filter((_, i) => i !== idx);
    setDiscoveryRanges(next);
    setRangesInput(next.join("\n"));
  };

  const runDryRun = async () => {
    setDryRunLoading(true);
    setDryRunResult(null);
    try {
      const job = await api.post("/api/scan/dry-run/jobs", {});
      if (!job?.job_id) throw new Error("Dry run job could not be created");
      // Poll until done
      const poll = setInterval(async () => {
        try {
          const st = await api.get(`/api/scan/jobs/${job.job_id}`);
          if (st?.result) {
            const preview = st.result?.preview ?? [];
            setDryRunResult({
              status: st.result.status,
              scanned: st.result.scanned,
              found: st.result.found,
              errors: st.result.errors,
              total_duration_ms: st.result.total_duration_ms,
              preview,
            });
          }
          if (st?.status && st.status !== "running") {
            clearInterval(poll);
            setDryRunLoading(false);
          }
        } catch (_) {}
      }, 2000);
    } catch (ex) {
      setDryRunResult({ status: "error", errors: [String(ex)], preview: [] });
      setDryRunLoading(false);
    }
  };

  const fmtDuration = (ms) => {
    const value = Number(ms || 0);
    if (value < 1000) return `${value} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  };

  const discoverySeconds = Math.max(0, Number(discoveryIntervalSec) || 0);
  const portSeconds = Math.max(0, Number(portUpdateIntervalSec) || 0);
  const discoveryLabel = discoverySeconds === 0
    ? "disabled"
    : discoverySeconds >= 60
      ? `${(discoverySeconds / 60).toFixed(discoverySeconds % 60 === 0 ? 0 : 1)} min`
      : `${discoverySeconds}s`;
  const portsLabel = portSeconds === 0 ? "disabled" : `${portSeconds}s`;

  const fmtTs = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = (jobId) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await api.get(`/api/scan/jobs/${jobId}`);
        if (st?.result) {
          setScanResult(st.result);
        }
        if (st?.status && st.status !== "running") {
          setScanning(false);
          setActiveJobId(null);
          stopPolling();
          loadHistory();
        }
      } catch (_) {
        // keep polling on transient UI/API glitches
      }
    }, 1500);
  };

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const job = await api.post("/api/scan/jobs", {});
      if (!job?.job_id) throw new Error("Scan job could not be created");
      setActiveJobId(job.job_id);
      startPolling(job.job_id);
    } catch (e) {
      setScanning(false);
      setScanResult({ scanned: 0, found: 0, links: 0, errors: [String(e)], status: "failed" });
    }
  };

  const cancelScan = async () => {
    if (!activeJobId) return;
    await api.post(`/api/scan/jobs/${activeJobId}/cancel`, {});
  };

  const btnStyle = {
    border: "1px solid #164e63", background: "#083344", color: "#22d3ee",
    borderRadius: 6, padding: "10px 24px", cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600,
    transition: "all 0.15s",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Scan action */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
        padding: 20, display: "flex", flexDirection: "column", gap: 14,
      }}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>NETWORK SCAN</div>
        <div style={{ color: "#475569", fontSize: 11, lineHeight: 1.6 }}>
          Discovers switches, ports, and LLDP neighbor links from enabled SNMP credentials.
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>GENERAL ENGINE SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>Parallel Workers (Hosts)</span>
            <input
              type="number"
              min={1}
              max={128}
              value={scanWorkers}
              onChange={e => setScanWorkers(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#64748b", fontSize:10, marginLeft:8 }}>Timeout (s)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={snmpTimeout}
              onChange={e => setSnmpTimeout(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#64748b", fontSize:10, marginLeft:8 }}>Retries</span>
            <input
              type="number"
              min={0}
              max={10}
              value={snmpRetries}
              onChange={e => setSnmpRetries(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <button
              onClick={saveScanSettings}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
                borderRadius:6, padding:"5px 10px", cursor:(settingsLoading || settingsSaving || scanning)?"default":"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
                opacity:(settingsLoading || settingsSaving || scanning)?0.6:1,
              }}
            >{settingsSaving ? "Saving..." : "Save Scan Settings"}</button>
            <span style={{ color:"#334155", fontSize:10 }}>
              {settingsLoading ? "Loading settings..." : "1-128 workers"}
            </span>
          </div>
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>DISCOVERY SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>Discovery Full Scan Interval (sec)</span>
            <input
              type="number"
              min={0}
              max={86400}
              value={discoveryIntervalSec}
              onChange={e => setDiscoveryIntervalSec(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:84, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              current discovery schedule: {discoveryLabel}
            </span>
          </div>
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>PORT UPDATE SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>Port Poll Interval (sec)</span>
            <input
              type="number"
              min={0}
              max={3600}
              value={portUpdateIntervalSec}
              onChange={e => setPortUpdateIntervalSec(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:84, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              Set 0 to disable
            </span>
            <span style={{ color:"#334155", fontSize:10 }}>
              current port schedule: {portsLabel}
            </span>
          </div>
        </div>
        {/* Discovery IP Ranges */}
        <div style={{
          display:"flex", flexDirection:"column", gap:10,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>DISCOVERY IP RANGES</div>
          <div style={{ color:"#475569", fontSize:10, lineHeight:1.6 }}>
            IPs or CIDR ranges scanned automatically during discovery. Responding hosts are added as credentials. One entry per line (e.g. 192.168.1.0/24).
          </div>
          {/* Existing ranges as removable chips */}
          {discoveryRanges.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {discoveryRanges.map((r, idx) => (
                <span key={idx} style={{
                  display:"inline-flex", alignItems:"center", gap:5,
                  backgroundColor:"#0c1220", border:"1px solid #1e3a52", borderRadius:5,
                  padding:"2px 8px", fontSize:11, color:"#7dd3fc", fontFamily:"monospace",
                }}>
                  {r}
                  <button
                    onClick={() => removeRange(idx)}
                    style={{
                      background:"none", border:"none", color:"#64748b", cursor:"pointer",
                      padding:0, fontSize:13, lineHeight:1, fontFamily:"inherit",
                    }}
                    title="Remove"
                  >x</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            rows={4}
            value={rangesInput}
            onChange={e => setRangesInput(e.target.value)}
            placeholder={"192.168.1.0/24\n10.0.0.0/16\n172.16.5.42"}
            disabled={settingsLoading || rangesSaving}
            style={{
              backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
              color:"#e2e8f0", padding:"6px 8px", fontFamily:"monospace", fontSize:11,
              resize:"vertical", minHeight:70,
            }}
          />
          {rangesError && (
            <div style={{ color:"#f87171", fontSize:11 }}>{rangesError}</div>
          )}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <button
              onClick={saveDiscoveryRanges}
              disabled={settingsLoading || rangesSaving}
              style={{
                border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
                borderRadius:6, padding:"5px 12px", cursor:(settingsLoading || rangesSaving)?"default":"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
                opacity:(settingsLoading || rangesSaving)?0.6:1,
              }}
            >{rangesSaving ? "Saving..." : "Save Ranges"}</button>
            <button
              onClick={runDryRun}
              disabled={settingsLoading || dryRunLoading || discoveryRanges.length === 0}
              style={{
                border:"1px solid #164e63", background:"#083344", color:"#22d3ee",
                borderRadius:6, padding:"5px 12px",
                cursor:(settingsLoading || dryRunLoading || discoveryRanges.length === 0)?"default":"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
                opacity:(settingsLoading || dryRunLoading || discoveryRanges.length === 0)?0.5:1,
              }}
            >{dryRunLoading ? "Scanning..." : "Dry Run"}</button>
            {discoveryRanges.length > 0 && (
              <span style={{ color:"#334155", fontSize:10 }}>{discoveryRanges.length} range(s) active</span>
            )}
          </div>
          {/* Dry run results */}
          {dryRunResult && (
            <div style={{
              marginTop:8, padding:"10px 12px",
              border:"1px solid #1e3a52", borderRadius:8, backgroundColor:"#0c1220",
            }}>
              <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:8 }}>
                DRY RUN RESULT - {dryRunResult.found ?? 0} host(s) found, {dryRunResult.scanned ?? 0} probed - {dryRunResult.total_duration_ms != null ? ((dryRunResult.total_duration_ms / 1000).toFixed(1) + "s") : ""}
              </div>
              {(dryRunResult.preview || []).length === 0 ? (
                <div style={{ color:"#475569", fontSize:11 }}>No responding hosts found in configured ranges.</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {(dryRunResult.preview || []).map((item, i) => (
                    <div key={i} style={{
                      display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
                      padding:"4px 8px", borderRadius:5,
                      backgroundColor: item.no_profile_suitable ? "#1c0a0a" : item.already_exists ? "#0a1a0a" : "#0a1220",
                      border: `1px solid ${item.no_profile_suitable ? "#7f1d1d" : item.already_exists ? "#14532d" : "#1e3a52"}`,
                    }}>
                      <span style={{ color:"#7dd3fc", fontFamily:"monospace", fontSize:11, minWidth:120 }}>{item.ip}</span>
                      <span style={{ color:"#94a3b8", fontSize:11 }}>{item.sys_name || "-"}</span>
                      {item.already_exists && (
                        <span style={{ color:"#4ade80", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#14532d30", border:"1px solid #14532d" }}>existing</span>
                      )}
                      {item.no_profile_suitable && (
                        <span style={{ color:"#f87171", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#7f1d1d30", border:"1px solid #7f1d1d" }}>no profile suitable</span>
                      )}
                      {!item.no_profile_suitable && !item.already_exists && (
                        <span style={{ color:"#22d3ee", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#083344", border:"1px solid #164e63" }}>would create credential</span>
                      )}
                      {item.vendor && item.vendor !== "unknown" && (
                        <span style={{ color:"#64748b", fontSize:10 }}>{item.vendor}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {(dryRunResult.errors || []).length > 0 && (
                <div style={{ marginTop:8, color:"#f87171", fontSize:10 }}>
                  {dryRunResult.errors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={runScan}
            disabled={scanning}
            style={{
              ...btnStyle,
              opacity: scanning ? 0.6 : 1,
              cursor: scanning ? "wait" : "pointer",
            }}
          >{scanning ? "Scanning..." : "Run Scan"}</button>
          {scanning && activeJobId && (
            <button
              onClick={cancelScan}
              style={{
                border:"1px solid #7f1d1d", background:"#1c1917", color:"#f87171",
                borderRadius:6, padding:"10px 18px", cursor:"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
              }}
            >Cancel</button>
          )}
          {scanning && (
            <span style={{ color: "#475569", fontSize: 10 }}>
              Job {activeJobId ? activeJobId.slice(0, 8) : "-"} is running...
            </span>
          )}
        </div>
      </div>

      {/* Latest result */}
      {scanResult && !scanning && (
        <div style={{
          backgroundColor: scanResult.errors?.length ? "#7f1d1d12" : "#14532d12",
          border: `1px solid ${scanResult.errors?.length ? "#7f1d1d" : "#14532d"}`,
          borderRadius: 8, padding: 14,
        }}>
          <div style={{
            color: scanResult.errors?.length ? "#f87171" : "#4ade80",
            fontSize: 11, fontWeight: 600, marginBottom: 8,
          }}>
            {scanResult.errors?.length ? "Scan completed with errors" : "Scan completed successfully"}
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>SCANNED</span>
              <span style={{ color: "#e2e8f0", fontSize: 16, fontWeight: 700 }}>{scanResult.scanned ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>FOUND</span>
              <span style={{ color: "#22d3ee", fontSize: 16, fontWeight: 700 }}>{scanResult.found ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>LINKS</span>
              <span style={{ color: "#a78bfa", fontSize: 16, fontWeight: 700 }}>{scanResult.links ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>TOTAL TIME</span>
              <span style={{ color: "#7dd3fc", fontSize: 16, fontWeight: 700 }}>{fmtDuration(scanResult.total_duration_ms)}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>WORKERS</span>
              <span style={{ color: "#94a3b8", fontSize: 16, fontWeight: 700 }}>{scanResult.max_workers ?? 1}</span>
            </div>
          </div>
          {scanResult.switch_metrics?.length > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 8 }}>
              <div style={{ color: "#94a3b8", fontSize: 9, letterSpacing: 1, marginBottom: 6 }}>
                SWITCH DURATIONS
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:180, overflowY:"auto" }}>
                {scanResult.switch_metrics.map((m, i) => (
                  <div key={`${m.ip}-${i}`} style={{
                    display:"grid", gridTemplateColumns:"1fr 90px 60px", gap:8,
                    fontSize:10, padding:"4px 0", borderBottom:i < scanResult.switch_metrics.length - 1 ? "1px solid #0f172a" : "none",
                  }}>
                    <span style={{ color:m.success ? "#94a3b8" : "#fda4af", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {(m.label ? `${m.label} ` : "") + `(${m.ip})`}
                    </span>
                    <span style={{ color:"#7dd3fc", textAlign:"right" }}>{fmtDuration(m.duration_ms)}</span>
                    <span style={{ color:m.success ? "#4ade80" : "#f87171", textAlign:"right" }}>{m.success ? "OK" : "FAIL"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {scanResult.errors?.length > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #7f1d1d33", paddingTop: 8 }}>
              <div style={{ color: "#f87171", fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>ERRORS</div>
              {scanResult.errors.map((e, i) => (
                <div key={i} style={{ color: "#fb7185", fontSize: 10, padding: "2px 0" }}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session history */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
        padding: 14,
      }}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>
          SCAN HISTORY (persisted)
        </div>
        {historyLoading ? (
          <div style={{ color: "#334155", fontSize: 10 }}>Loading...</div>
        ) : history.length === 0 ? (
          <div style={{ color: "#334155", fontSize: 10 }}>No scan runs yet</div>
        ) : history.map((h) => (
          <div key={h.id} style={{
            display: "flex", flexDirection:"column", alignItems: "stretch", gap: 4,
            padding: "6px 0", borderBottom: "1px solid #0f172a",
            fontSize: 10,
          }}>
            <div style={{display:"flex", alignItems:"center", gap: 12}}>
              <span style={{ color: "#334155", minWidth: 70 }}>{fmtTs(h.created_at)}</span>
              <span style={{ color: h.status === "finished" ? "#4ade80" : h.status === "cancelled" ? "#f59e0b" : "#f87171", minWidth: 22 }}>
                {h.status === "finished" ? "OK" : h.status === "cancelled" ? "CAN" : "ERR"}
              </span>
              <span style={{ color: "#94a3b8" }}>
                {h.found} switches, {h.links} links
                <span style={{ color: "#64748b" }}> - {fmtDuration(h.total_duration_ms)}</span>
                <span style={{ color: "#475569" }}> - w:{h.max_workers}</span>
                {h.error_count > 0 && <span style={{ color: "#f87171" }}> ({h.error_count} errors)</span>}
              </span>
            </div>
            <div style={{display:"flex", gap:10, flexWrap:"wrap", paddingLeft:82, color:"#64748b"}}>
              <span style={{color:(h.new_devices?.length||0)>0?"#4ade80":"#64748b"}}>+dev {h.new_devices?.length || 0}</span>
              <span style={{color:(h.removed_devices?.length||0)>0?"#f87171":"#64748b"}}>-dev {h.removed_devices?.length || 0}</span>
              <span style={{color:(h.new_links?.length||0)>0?"#22d3ee":"#64748b"}}>+link {h.new_links?.length || 0}</span>
              <span style={{color:(h.removed_links?.length||0)>0?"#f59e0b":"#64748b"}}>-link {h.removed_links?.length || 0}</span>
            </div>
            {((h.new_devices?.length || 0) > 0 || (h.removed_devices?.length || 0) > 0) && (
              <div style={{paddingLeft:82, color:"#64748b", display:"flex", flexDirection:"column", gap:2}}>
                {h.new_devices?.length > 0 && <div>new devices: {h.new_devices.join(", ")}</div>}
                {h.removed_devices?.length > 0 && <div>removed devices: {h.removed_devices.join(", ")}</div>}
              </div>
            )}
            {((h.new_links?.length || 0) > 0 || (h.removed_links?.length || 0) > 0) && (
              <div style={{paddingLeft:82, color:"#64748b", display:"flex", flexDirection:"column", gap:2}}>
                {h.new_links?.length > 0 && <div>new links: {h.new_links.slice(0, 3).join(" | ")}{h.new_links.length > 3 ? " ..." : ""}</div>}
                {h.removed_links?.length > 0 && <div>removed links: {h.removed_links.slice(0, 3).join(" | ")}{h.removed_links.length > 3 ? " ..." : ""}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Legacy local history hidden when persistent history is active */}
      {false && history.length > 0 && (
        <div style={{
          backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
          padding: 14,
        }}>
          <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>
            SCAN HISTORY (this session)
          </div>
          {history.map((h, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "6px 0", borderBottom: i < history.length - 1 ? "1px solid #0f172a" : "none",
              fontSize: 10,
            }}>
              <span style={{ color: "#334155", minWidth: 60 }}>{h.ts}</span>
              <span style={{ color: h.errors?.length ? "#f87171" : "#4ade80", minWidth: 12 }}>
                {h.errors?.length ? "!" : "+"}
              </span>
              <span style={{ color: "#94a3b8" }}>
                {h.found} switches, {h.links} links
                {h.total_duration_ms != null && <span style={{ color: "#64748b" }}> - {fmtDuration(h.total_duration_ms)}</span>}
                {h.errors?.length > 0 && <span style={{ color: "#f87171" }}> ({h.errors.length} errors)</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── DnsSettingsTabContent ───────────────────────────────────────────────────
function DnsSettingsTabContent() {
  const [serversText, setServersText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api.get("/api/dns-settings")
      .then(data => {
        const servers = Array.isArray(data?.servers) ? data.servers : [];
        setServersText(servers.join("\n"));
      })
      .catch(() => setErr("Failed to load DNS settings"))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr("");
    setOk("");
    try {
      const servers = serversText
        .split(/[\n,;]/)
        .map(v => v.trim())
        .filter(Boolean);

      const result = await api.put("/api/dns-settings", { servers });
      const normalized = Array.isArray(result?.servers) ? result.servers : servers;
      setServersText(normalized.join("\n"));
      setOk("DNS settings saved");
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const boxStyle = {
    backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
    padding: 20, display: "flex", flexDirection: "column", gap: 12,
  };

  const textareaStyle = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:6,
    color:"#e2e8f0", padding:"8px 10px", minHeight:140, resize:"vertical",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, width:"100%",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={boxStyle}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>DNS RESOLVER</div>
        <div style={{ color: "#475569", fontSize: 11, lineHeight: 1.6 }}>
          Configure DNS servers for reverse lookup of peer hostnames during scans.
          Leave empty to use system/default DNS resolver.
        </div>

        {loading ? (
          <div style={{ color:"#334155", fontSize:11 }}>Loading...</div>
        ) : (
          <>
            <textarea
              value={serversText}
              onChange={e => setServersText(e.target.value)}
              placeholder={"One DNS server IP per line, e.g.\n10.0.0.10\n1.1.1.1"}
              style={textareaStyle}
            />
            <div style={{ color:"#334155", fontSize:10 }}>
              Accepted formats: IPv4 and IPv6. You can also separate values by comma.
            </div>
            {err && <div style={{ color:"#f87171", fontSize:11 }}>{err}</div>}
            {ok && <div style={{ color:"#4ade80", fontSize:11 }}>{ok}</div>}
            <div style={{ display:"flex", gap:8 }}>
              <button
                onClick={save}
                disabled={saving}
                style={{
                  border:"1px solid #164e63", background:"#083344", color:"#22d3ee",
                  borderRadius:6, padding:"8px 16px", cursor:saving ? "wait" : "pointer",
                  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
                  opacity:saving ? 0.7 : 1,
                }}
              >{saving ? "Saving..." : "Save DNS Settings"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


function DataImportExportTabContent({ onProfilesChanged }) {
  const [configDryRun, setConfigDryRun] = useState(true);
  const [configData, setConfigData] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [configMsg, setConfigMsg] = useState("");

  const exportConfig = async () => {
    setConfigBusy(true);
    setConfigMsg("");
    try {
      const res = await api.get("/api/config/export");
      setConfigData(res?.data || "");
      setConfigMsg("Global config exported");
    } catch (ex) {
      setConfigMsg(String(ex));
    } finally {
      setConfigBusy(false);
    }
  };

  const importConfig = async () => {
    setConfigBusy(true);
    setConfigMsg("");
    try {
      const res = await api.post("/api/config/import", {
        data: configData,
        dry_run: configDryRun,
      });
      const errorCount = Array.isArray(res?.errors) ? res.errors.length : 0;
      setConfigMsg(`${configDryRun ? "Dry-run" : "Restore"}: settings ${res?.totals?.settings ?? 0}, profiles ${res?.totals?.profiles ?? 0}, credentials ${res?.totals?.credentials ?? 0}, errors ${errorCount}`);
      if (!configDryRun) onProfilesChanged?.();
      if (errorCount > 0) {
        const details = res.errors.map(e => `${e.section} row ${e.row}: ${e.message}`).join("\n");
        setConfigData(prev => `${prev}\n\n# Validation Errors\n${details}`);
      }
    } catch (ex) {
      setConfigMsg(String(ex));
    } finally {
      setConfigBusy(false);
    }
  };


  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20,display:"flex",flexDirection:"column",gap:14}}>
      <div style={{backgroundColor:"#0a0e18",border:"1px solid #1e293b",borderRadius:10,padding:"12px"}}>
        <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1,marginBottom:8}}>GLOBAL BACKUP & RESTORE</div>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
          <label style={{display:"flex",alignItems:"center",gap:6,color:"#94a3b8",fontSize:11}}>
            <input type="checkbox" checked={configDryRun} onChange={e=>setConfigDryRun(e.target.checked)} /> Dry-run restore
          </label>
          <button type="button" onClick={exportConfig} disabled={configBusy} style={{background:"none",border:"1px solid #1e293b",color:"#94a3b8",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:11}}>Export Config</button>
          <button type="button" onClick={importConfig} disabled={configBusy || !configData.trim()} style={{background:"none",border:"1px solid #1e293b",color:"#94a3b8",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:11}}>Import Config</button>
          {configMsg && <span style={{color:"#64748b",fontSize:10}}>{configMsg}</span>}
        </div>
        <textarea
          value={configData}
          onChange={e=>setConfigData(e.target.value)}
          placeholder='{"version":1,"settings":[...],"profiles":[...],"credentials":[...]}'
          style={{width:"100%",minHeight:140,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:6,color:"#e2e8f0",padding:"8px",fontFamily:"'Inter', system-ui, sans-serif",fontSize:11,boxSizing:"border-box"}}
        />
      </div>
    </div>
  );
}


// ── SettingsPage (main export) ──────────────────────────────────────────────
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("switches");
  const [profiles, setProfiles]   = useState([]);
  const [profLoading, setProfLoading] = useState(true);

  // Map background state
  const [mapBgUrl, setMapBgUrl]   = useState(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);
  const bgFileRef = useRef(null);

  const refreshProfiles = () => {
    setProfLoading(true);
    api.get("/api/snmp-profiles").then(d => { setProfiles(d); setProfLoading(false); }).catch(() => setProfLoading(false));
  };
  useEffect(() => { refreshProfiles(); }, []);

  // Load map background
  useEffect(() => {
    fetch(`${API}/api/map-background`, { method: "GET" })
      .then(r => { if (r.ok) setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`); })
      .catch(() => {});
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
    }).catch(() => {});
  }, []);

  const uploadMapBg = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`${API}/api/map-background`, { method: "POST", body: fd });
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
  };

  const removeMapBg = async () => {
    await fetch(`${API}/api/map-background`, { method: "DELETE" });
    setMapBgUrl(null);
  };

  const changeBgOpacity = (val) => {
    setMapBgOpacity(val);
    api.put("/api/map-settings", { opacity: val }).catch(console.error);
  };

  const changeBgScale = (val) => {
    setMapBgScale(val);
    api.put("/api/map-settings", { scale: val }).catch(console.error);
  };

  const NAV_GROUPS = [
    {
      group: "CREDENTIALS",
      items: [
        { tab:"profiles", label:"Profiles",  desc:"Global SNMP profiles" },
      ],
    },
    {
      group: "INFRASTRUCTURE",
      items: [
        { tab:"switches", label:"Switches",  desc:"Credentials" },
        { tab:"racks",    label:"Racks",     desc:"Rack definitions" },
        { tab:"classes",  label:"Classes",   desc:"Device roles / classes" },
        { tab:"models",   label:"Models",    desc:"Switch models & port layout" },
      ],
    },
    {
      group: "ENGINE",
      items: [
        { tab:"scan",     label:"Scan",      desc:"Network discovery" },
        { tab:"dns",      label:"DNS",       desc:"Reverse lookup servers" },
      ],
    },
    {
      group: "APPEARANCE",
      items: [
        { tab:"map",      label:"Map",       desc:"Background image settings" },
      ],
    },
    {
      group: "BACKUP",
      items: [
        { tab:"data",     label:"Backup & Restore", desc:"Global config export/import" },
      ],
    },
  ];

  const allNavItems = NAV_GROUPS.flatMap(g => g.items);

  return (
    <div style={{
      display:"flex", height:"calc(100vh - 48px)", overflow:"hidden",
      backgroundColor:"#020817", fontFamily:"'Inter', system-ui, sans-serif",
      color:"#e2e8f0", fontSize:12, lineHeight:1.4,
    }}>
      {/* Sidebar */}
      <div style={{
        width:220, borderRight:"1px solid #0f172a", flexShrink:0,
        backgroundColor:"#020817", padding:"24px 12px",
        display:"flex", flexDirection:"column", gap:4,
      }}>
        <div style={{color:"#64748b",fontSize:10,letterSpacing:2,marginBottom:12,paddingLeft:8}}>
          SETTINGS
        </div>
        {NAV_GROUPS.map(({ group, items }, gi) => (
          <div key={group}>
            {gi > 0 && <div style={{height:1,backgroundColor:"#0f172a",margin:"8px 8px"}}/>}
            <div style={{color:"#64748b",fontSize:10,letterSpacing:2,padding:"6px 8px 4px",userSelect:"none"}}>
              {group}
            </div>
            {items.map(({ tab, label, desc }) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              display:"flex", alignItems:"center", gap:10,
              padding:"10px 12px", borderRadius:8, cursor:"pointer",
              border:"none", textAlign:"left", width:"100%",
              backgroundColor: activeTab===tab ? "#083344" : "transparent",
              outline: activeTab===tab ? "1px solid #164e63" : "1px solid transparent",
              transition:"all 0.15s",
            }}
          >
            <div>
              <div style={{fontSize:12, fontWeight:600, color: activeTab===tab ? "#22d3ee" : "#94a3b8", fontFamily:"inherit"}}>
                {label}
              </div>
              <div style={{fontSize:10, color: activeTab===tab ? "#7dd3fc" : "#64748b", marginTop:1, fontFamily:"inherit"}}>
                {desc}
              </div>
            </div>
          </button>
            ))}
          </div>
        ))}
      </div>

      {/* Content area */}
      <div style={{
        flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
        backgroundColor:"#020917",
      }}>
        <div style={{padding:"20px 32px 0",flexShrink:0}}>
          <div style={{color:"#e2e8f0",fontWeight:700,fontSize:18}}>
            {allNavItems.find(n=>n.tab===activeTab)?.label}
          </div>
          <div style={{color:"#64748b",fontSize:12,marginTop:3}}>
            {allNavItems.find(n=>n.tab===activeTab)?.desc}
          </div>
          <div style={{height:1,backgroundColor:"#0f172a",marginTop:14}}/>
        </div>

        <div style={{flex:1, overflow:"hidden", display:"flex", maxWidth:900, width:"100%", padding:"0 32px 20px"}}>
          {activeTab === "switches" && <CredentialsTabContent profiles={profiles} />}
          {activeTab === "profiles" && <SnmpProfilesTabContent profiles={profiles} loading={profLoading} onChanged={refreshProfiles} />}
          {activeTab === "data"     && <DataImportExportTabContent onProfilesChanged={refreshProfiles} />}
          {activeTab === "racks"    && <RacksTabContent />}
          {activeTab === "classes"  && <ClassesTabContent />}
          {activeTab === "models"   && <ModelsTabContent />}
          {activeTab === "scan"     && <EngineTabContent />}
          {activeTab === "dns"      && <DnsSettingsTabContent />}
          {activeTab === "map"      && (
            <MapSettingsTabContent
              url={mapBgUrl}
              opacity={mapBgOpacity}
              scale={mapBgScale}
              fileRef={bgFileRef}
              onUpload={uploadMapBg}
              onRemove={removeMapBg}
              onChangeOpacity={changeBgOpacity}
              onChangeScale={changeBgScale}
            />
          )}
        </div>
      </div>
    </div>
  );
}
