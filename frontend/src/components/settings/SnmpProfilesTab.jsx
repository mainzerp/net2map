import { useState, useRef } from "react";
import { api, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../../api.js";

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
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
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

  const remove = (id) => setConfirmDeleteId(id);
  const removeConfirmed = async (id) => {
    await api.del(`/api/snmp-profiles/${id}`); setConfirmDeleteId(null); onChanged();
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
          {!isV3 && (
            <div style={{marginBottom:8}}>
              <label style={{fontSize:10,color:"#94a3b8",display:"block"}}>Community String *
                <input required value={F.community} onChange={e=>set("community",e.target.value)} placeholder="public" style={{...inp,marginTop:3}}/>
                {F.community === "public" && (
                  <span style={{ color: "#f39c12", fontSize: 11, display: "block", marginTop: 2 }}>
                    Warning: &quot;public&quot; is the factory-default community string and may allow unauthorised SNMP access.
                  </span>
                )}
              </label>
            </div>
          )}
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
            {confirmDeleteId === p.id ? (
              <span style={{display:"flex",gap:4}}>
                <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>removeConfirmed(p.id)}>Confirm</button>
                <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
              </span>
            ) : (
              <button onClick={()=>remove(p.id)} style={{background:"none",border:"1px solid #450a0a",color:"#7f1d1d",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}}>X</button>
            )}
          </div>
        ))}
      </div>
  );
}

export default SnmpProfilesTabContent;
