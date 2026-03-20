import { useState, useEffect } from "react";
import { api, extractErrorMessage, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../../api";
import type { SnmpProfile } from "../../types";

// ── SnmpProfilesTabContent ──────────────────────────────────────────────────
interface ProfileForm {
  label: string;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface SnmpProfilesTabContentProps {
  profiles: SnmpProfile[];
  loading: boolean;
  onChanged: () => void;
  newEntryTrigger: number;
  loadError: string;
}

const EMPTY_PROFILE_FORM: ProfileForm = {
  label:"",
  snmp_version:"v2c", community:"public",
  v3_security_level:"authPriv", v3_username:"",
  v3_auth_protocol:"SHA-256", v3_auth_password:"",
  v3_priv_protocol:"AES-128", v3_priv_password:"",
};

function SnmpProfilesTabContent({ profiles, loading, onChanged, newEntryTrigger, loadError }: SnmpProfilesTabContentProps) {
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm]         = useState<ProfileForm>({ ...EMPTY_PROFILE_FORM });
  const [err, setErr]           = useState<string>("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => { setForm({ ...EMPTY_PROFILE_FORM }); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_PROFILE_FORM }); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (p: SnmpProfile) => {
    setEditState({ id: p.id, open: true });
    setForm({
      label:p.label, snmp_version:p.snmp_version, community:p.community,
      v3_security_level:p.v3_security_level, v3_username:p.v3_username,
      v3_auth_protocol:p.v3_auth_protocol, v3_auth_password:p.v3_auth_password,
      v3_priv_protocol:p.v3_priv_protocol, v3_priv_password:p.v3_priv_password,
    });
    setErr("");
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr("");
    try {
      if (editState.id) { await api.put(`/api/snmp-profiles/${editState.id}`, form); }
      else {
        const r = await api.post("/api/snmp-profiles", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); onChanged();
    } catch (ex) { setErr(extractErrorMessage(ex)); }
  };

  const remove = (id: number) => setConfirmDeleteId(id);
  const removeConfirmed = async (id: number) => {
    await api.del(`/api/snmp-profiles/${id}`); setConfirmDeleteId(null); onChanged();
  };

  const F = form;
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm(p => ({ ...p, [k]: v }));
  const isV3 = F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";

  const inp: React.CSSProperties = { backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5, color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%" };
  const sel: React.CSSProperties = { ...inp, cursor:"pointer" };
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
                {editState.id ? "EDIT PROFILE" : "NEW PROFILE"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>{"\u2715"}</button>
            </div>
            <div style={{marginBottom:8}}>
              <label style={lbl}>Profile name *
                <input required value={F.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("label",e.target.value)} placeholder="SNMPv3 Aruba Core" style={{...inp,marginTop:3}}/>
              </label>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>SNMP Version</div>
              <div style={{display:"flex",gap:6}}>
                {(["v2c","v3"] as const).map(v=>(
                  <button key={v} type="button" onClick={()=>set("snmp_version",v)} style={{padding:"4px 14px",borderRadius:5,fontSize:11,cursor:"pointer",fontFamily:"'Inter', system-ui, sans-serif",fontWeight:F.snmp_version===v?600:400,backgroundColor:F.snmp_version===v?"#083344":"transparent",border:`1px solid ${F.snmp_version===v?"#164e63":"#1e293b"}`,color:F.snmp_version===v?"#22d3ee":"#64748b"}}>{v}</button>
                ))}
              </div>
            </div>
            {!isV3 && (
              <div style={{marginBottom:8}}>
                <label style={lbl}>Community String *
                  <input required value={F.community} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("community",e.target.value)} placeholder="public" style={{...inp,marginTop:3}}/>
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
                <label style={lbl}>Security Level
                  <select value={F.v3_security_level} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set("v3_security_level",e.target.value)} style={{...sel,marginTop:3}}>
                    {SEC_LEVELS.map(l=><option key={l}>{l}</option>)}
                  </select>
                </label>
                <label style={lbl}>Username
                  <input value={F.v3_username} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("v3_username",e.target.value)} style={{...inp,marginTop:3}}/>
                </label>
                {needAuth && <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <label style={lbl}>Auth Protocol
                      <select value={F.v3_auth_protocol} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set("v3_auth_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                        {AUTH_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                      </select>
                    </label>
                    <label style={lbl}>Auth Password
                      <input type="password" value={F.v3_auth_password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("v3_auth_password",e.target.value)} style={{...inp,marginTop:3}}/>
                    </label>
                  </div>
                </>}
                {needPriv && <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <label style={lbl}>Priv Protocol
                      <select value={F.v3_priv_protocol} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set("v3_priv_protocol",e.target.value)} style={{...sel,marginTop:3}}>
                        {PRIV_PROTOCOLS.map(p=><option key={p}>{p}</option>)}
                      </select>
                    </label>
                    <label style={lbl}>Priv Password
                      <input type="password" value={F.v3_priv_password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("v3_priv_password",e.target.value)} style={{...inp,marginTop:3}}/>
                    </label>
                  </div>
                </>}
              </div>
            )}
            {err && <div style={{color:"#f87171",fontSize:11,marginTop:8}}>{err}</div>}
            <div style={{ display:"flex", gap:8, marginTop:14 }}>
              <button type="submit" style={{flex:1,backgroundColor:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:6,padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600}}>
                {editState.id ? "Save" : "Create profile"}
              </button>
              <button type="button" onClick={resetForm} style={{border:"1px solid #1e293b",background:"none",color:"#64748b",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Card grid listing */}
      {loadError && (
        <div style={{color:"#f87171", fontSize:11, padding:"8px 12px", backgroundColor:"#1c1917", border:"1px solid #7f1d1d", borderRadius:6, marginBottom:8}}>
          {loadError}
        </div>
      )}
      {loading ? (
        <div style={{color:"#475569",fontSize:11}}>Loading...</div>
      ) : profiles.length === 0 ? (
        <div style={{color:"#475569",fontSize:11,textAlign:"center",marginTop:20}}>No profiles defined yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(300px, 1fr))",gap:8}}>
          {profiles.map(p => {
            const isV3Card = p.snmp_version === "v3";
            const accentColor = isV3Card ? "#8b5cf6" : "#22d3ee";
            return (
              <div key={p.id} style={{ display:"flex", flexDirection:"column", padding:"10px 12px", backgroundColor:"#0a0e18", border:`1px solid ${accentColor}44`, borderRadius:8, position:"relative", overflow:"hidden" }}>
                <div style={{ position:"absolute", top:0, left:0, width:3, bottom:0, backgroundColor:accentColor, borderRadius:"8px 0 0 8px" }} />
                <div style={{ marginLeft:12 }}>
                  <div style={{ display:"flex", alignItems:"flex-start" }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ color:"#e2e8f0", fontWeight:600, fontSize:13 }}>{p.label}</span>
                        <span style={{
                          fontSize:10, padding:"1px 6px", borderRadius:4,
                          backgroundColor: isV3Card ? "#1e1b4b" : "#083344",
                          border: `1px solid ${isV3Card ? "#3730a3" : "#164e63"}`,
                          color: accentColor,
                        }}>
                          {p.snmp_version}
                        </span>
                      </div>
                      <div style={{ color:"#475569", fontSize:10, marginTop:2 }}>
                        {isV3Card ? `${p.v3_security_level} - ${p.v3_username || "-"}` : `Community: ${p.community}`}
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                      <button onClick={()=>startEdit(p)} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Edit</button>
                      {confirmDeleteId === p.id ? (
                        <span style={{display:"flex",gap:4}}>
                          <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>removeConfirmed(p.id)}>Confirm</button>
                          <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontFamily:"'Inter', system-ui, sans-serif"}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button onClick={()=>remove(p.id)} style={{ background:"none", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Inter', system-ui, sans-serif" }}>Delete</button>
                      )}
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

export default SnmpProfilesTabContent;
