import { useState, useEffect } from "react";
import { api, extractErrorMessage, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../../api";
import type { Credential, SnmpProfile, TopologyNode, RackInfo, SwitchClass } from "../../types";

// ── Local interfaces ────────────────────────────────────────────────────────
interface CredentialForm {
  label: string;
  ip: string;
  priority: number;
  snmp_port: number;
  enabled: boolean;
  profile_id: number | null;
  device_id: number | null;
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

interface CredentialsTabContentProps {
  profiles: SnmpProfile[];
  newEntryTrigger: number;
}

// ── CredentialsTabContent ────────────────────────────────────────────────────
const EMPTY_FORM: CredentialForm = {
  label:"", ip:"", priority:0, snmp_port:161, enabled:true,
  profile_id: null,
  device_id: null,
  snmp_version:"v2c", community:"public",
  v3_security_level:"authPriv", v3_username:"",
  v3_auth_protocol:"SHA-256", v3_auth_password:"",
  v3_priv_protocol:"AES-128", v3_priv_password:"",
};

function CredentialsTabContent({ profiles, newEntryTrigger }: CredentialsTabContentProps) {
  const [creds, setCreds]       = useState<Credential[]>([]);
  const [devices, setDevices]   = useState<TopologyNode[]>([]);
  const [racks, setRacks]       = useState<RackInfo[]>([]);
  const [classes, setClasses]   = useState<SwitchClass[]>([]);
  const [loading, setLoading]   = useState<boolean>(true);
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm]         = useState<CredentialForm>({ ...EMPTY_FORM });
  const [err, setErr]           = useState<string>("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [togglingIgnoreId, setTogglingIgnoreId] = useState<number | null>(null);

  // Open the new-entry form whenever the parent increments the trigger
  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const refresh = () => {
    setLoading(true);
    Promise.allSettled([
      api.get("/api/credentials"),
      api.get("/api/devices"),
      api.get("/api/racks"),
      api.get("/api/switch-classes"),
    ])
      .then(([credsRes, topoRes, racksRes, classesRes]) => {
        if (credsRes.status === "fulfilled") setCreds(credsRes.value);
        else setCreds([]);
        if (topoRes.status === "fulfilled") setDevices(Array.isArray(topoRes.value) ? topoRes.value : (topoRes.value?.nodes || []));
        else setDevices([]);
        if (racksRes.status === "fulfilled") setRacks(racksRes.value || []);
        else setRacks([]);
        if (classesRes.status === "fulfilled") setClasses(classesRes.value || []);
        else setClasses([]);
        setLoading(false);
      });
  };
  useEffect(() => { refresh(); }, []);

  const resetForm = () => { setForm({ ...EMPTY_FORM }); setEditState({ id: null, open: false }); setErr(""); };

  const startNew = () => {
    setForm({ ...EMPTY_FORM });
    setEditState({ id: null, open: true });
    setErr("");
  };

  const startEdit = (c: Credential) => {
    setForm({
      label:c.label, ip:c.ip, priority:c.priority ?? 0, snmp_port:c.snmp_port, enabled:c.enabled,
      profile_id: c.profile_id ?? null,
      device_id: c.device_id ?? null,
      snmp_version:c.snmp_version, community:c.community,
      v3_security_level:c.v3_security_level, v3_username:c.v3_username,
      v3_auth_protocol:c.v3_auth_protocol,   v3_auth_password:c.v3_auth_password,
      v3_priv_protocol:c.v3_priv_protocol,   v3_priv_password:c.v3_priv_password,
    });
    setEditState({ id: c.id, open: true });
    setErr("");
  };

  const toggleIgnored = async (dev: TopologyNode) => {
    setTogglingIgnoreId(dev.id);
    try {
      await api.patch(`/api/topology/devices/${dev.id}/meta`, { ignored: !dev.ignored });
      api.invalidate("/api/topology", "/api/devices");
      refresh();
    } finally {
      setTogglingIgnoreId(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try {
      if (editState.id) { await api.put(`/api/credentials/${editState.id}`, form); }
      else {
        const r = await api.post("/api/credentials", form);
        if (r.detail) { setErr(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)); return; }
      }
      resetForm(); refresh();
    } catch (ex) { setErr(extractErrorMessage(ex)); }
  };

  const remove = (id: number) => setConfirmDeleteId(id);
  const removeConfirmed = async (id: number) => {
    await api.del(`/api/credentials/${id}`); setConfirmDeleteId(null); refresh();
  };

  const F = form;
  const set = <K extends keyof CredentialForm>(k: K, v: CredentialForm[K]) => setForm(p => ({ ...p, [k]: v }));
  const isV3 = F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";

  const inp: React.CSSProperties = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
    color:"#e2e8f0", padding:"5px 8px",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, lineHeight:1.3, boxSizing:"border-box", width:"100%",
  };
  const selStyle: React.CSSProperties = { ...inp, cursor:"pointer" };
  const lbl = (): React.CSSProperties => ({ fontSize:10, color:"#94a3b8", display:"block", userSelect:"none" });

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
            width:560, maxHeight:"calc(100vh - 80px)", overflowY:"auto",
            backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12,
            padding:"20px", boxShadow:"0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1}}>
                {editState.id ? "EDIT ENTRY" : "NEW ENTRY"}
              </div>
              <button type="button" onClick={resetForm} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 2px"}}>&#x2715;</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <label style={lbl()}>Label *
                <input required value={F.label} onChange={e=>set("label",e.target.value)} placeholder="Core Switch RZ-01" style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>IP address *
                <input required value={F.ip} onChange={e=>set("ip",e.target.value)} placeholder="192.168.1.1" style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>Priority (0 = primary)
                <input type="number" min="0" value={F.priority} onChange={e=>set("priority",+e.target.value)} style={{...inp,marginTop:3}}/>
              </label>
              <label style={lbl()}>SNMP Port
                <input type="number" value={F.snmp_port} onChange={e=>set("snmp_port",+e.target.value)} style={{...inp,marginTop:3}}/>
              </label>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:"#94a3b8",marginBottom:4}}>Credential profile (optional)</div>
              <select
                value={F.profile_id ?? ""}
                onChange={e => set("profile_id", e.target.value ? +e.target.value : null)}
                style={{...selStyle}}
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
                    <select value={F.v3_security_level} onChange={e=>set("v3_security_level",e.target.value)} style={{...selStyle,marginTop:3}}>
                      {SEC_LEVELS.map(l=><option key={l} value={l}>{l}</option>)}
                    </select>
                  </label>
                </div>
                {needAuth && (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <label style={lbl()}>Auth protocol
                      <select value={F.v3_auth_protocol} onChange={e=>set("v3_auth_protocol",e.target.value)} style={{...selStyle,marginTop:3}}>
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
                      <select value={F.v3_priv_protocol} onChange={e=>set("v3_priv_protocol",e.target.value)} style={{...selStyle,marginTop:3}}>
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
      ) : creds.length === 0 ? (
        <div style={{color:"#64748b",fontSize:11,textAlign:"center",padding:20}}>No entries yet</div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8,marginBottom:20}}>
        {[...creds].sort((a,b) => (a.label||"").localeCompare(b.label||"")).map(c => {
          const v3 = c.snmp_version === "v3";
          const assignedProfile = c.profile_id ? profiles.find(p => p.id === c.profile_id) : null;
          const matchedDevice = devices.find(d => d.ip === c.ip);
          const assignedRack = matchedDevice?.rack_id ? racks.find(r => r.id === matchedDevice.rack_id) : null;
          return (
            <div key={c.id} style={{
              display:"flex", flexDirection:"column",
              padding:"10px 12px",
              backgroundColor: "#0a0e18",
              border:`1px solid ${c.enabled ? "#1e293b" : "#0f172a"}`,
              borderRadius:8, opacity: c.enabled ? 1 : 0.5,
            }}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                <div style={{minWidth:0,flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",backgroundColor:c.enabled?"#22c55e":"#64748b",flexShrink:0}}/>
                    <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{c.label}</span>
                    <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:v3?"#1e0b3a":"#0a0e18",
                      border:`1px solid ${v3?"#6d28d9":"#1e293b"}`,
                      color:v3?"#a78bfa":"#64748b",
                    }}>{c.snmp_version}</span>
                    {assignedRack ? (
                      <span title={`Rack: ${assignedRack.label}${assignedRack.room ? ` / ${assignedRack.room}` : ""}`} style={{
                        fontSize:10,padding:"1px 6px",borderRadius:3,
                        backgroundColor:"#0c1a2e",border:"1px solid #1e3a5f",color:"#7dd3fc",
                        maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                      }}>
                        {assignedRack.label}{assignedRack.room ? ` / ${assignedRack.room}` : ""}
                      </span>
                    ) : (
                      <span title="No rack assigned" style={{
                        fontSize:10,padding:"1px 6px",borderRadius:3,
                        backgroundColor:"#0c0f18",border:"1px solid #1e293b",color:"#334155",
                      }}>no rack</span>
                    )}
                    {matchedDevice && <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:"#052e16",border:"1px solid #166534",color:"#4ade80",
                    }}>discovered</span>}
                    {matchedDevice?.ignored && <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:"#450a0a",border:"1px solid #7f1d1d",color:"#f87171",
                    }}>ignored</span>}
                  </div>
                  <div style={{color:"#64748b",fontSize:10,marginTop:3,paddingLeft:14}}>
                    {c.ip}:{c.snmp_port}
                    {assignedProfile
                      ? <> - <span style={{color:"#7dd3fc"}}>{assignedProfile.label}</span></>
                      : !v3
                        ? <> - <span style={{color:"#64748b"}}>{c.community}</span></>
                        : <> - <span style={{color:"#64748b"}}>{c.v3_username}</span></>
                    }
                  </div>
                </div>
              </div>
              <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
                {matchedDevice && (
                  <button
                    disabled={togglingIgnoreId === matchedDevice.id}
                    onClick={() => toggleIgnored(matchedDevice)}
                    title={matchedDevice.ignored ? "Re-enable: scan this device and show on map" : "Ignore: skip scan and hide from map"}
                    style={{
                      background:"none",
                      border: matchedDevice.ignored ? "1px solid #164e63" : "1px solid #475569",
                      color: matchedDevice.ignored ? "#22d3ee" : "#64748b",
                      borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,
                      opacity: togglingIgnoreId === matchedDevice.id ? 0.5 : 1,
                    }}
                  >
                    {togglingIgnoreId === matchedDevice.id ? "..." : matchedDevice.ignored ? "Re-enable" : "Ignore"}
                  </button>
                )}
                <button onClick={() => startEdit(c)} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>Edit</button>
                {confirmDeleteId === c.id ? (
                  <span style={{display:"flex",gap:4}}>
                    <button style={{background:"#450a0a",border:"1px solid #7f1d1d",color:"#fca5a5",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>removeConfirmed(c.id)}>Confirm</button>
                    <button style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}} onClick={()=>setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => remove(c.id)} style={{background:"none",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10}}>X</button>
                )}
              </div>
            </div>
          );
        })}
        </div>
      )}
      {(() => {
        const credIps = new Set(creds.map(c => c.ip));
        const unassigned = devices.filter(d => !credIps.has(d.ip));
        if (unassigned.length === 0) return null;
        return (
          <div style={{marginTop:4}}>
            <div style={{color:"#e2e8f0",fontSize:10,letterSpacing:2,marginBottom:10}}>
              DISCOVERED WITHOUT CREDENTIALS ({unassigned.length})
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
            {[...unassigned].sort((a,b) => (a.sys_name||a.ip).localeCompare(b.sys_name||b.ip)).map(d => (
              <div key={d.id} style={{
                display:"flex", flexDirection:"column",
                padding:"10px 12px",
                backgroundColor:"#0a0e18", border:"1px solid #1e293b",
                borderRadius:8,
              }}>
                <div style={{marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",backgroundColor:"#eab308",flexShrink:0}}/>
                    <span style={{color:"#e2e8f0",fontWeight:600,fontSize:12}}>{d.sys_name || d.ip}</span>
                    <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:"#422006",border:"1px solid #854d0e",color:"#fbbf24",
                    }}>unassigned</span>
                    {d.ignored && <span style={{
                      fontSize:10,padding:"1px 5px",borderRadius:3,
                      backgroundColor:"#450a0a",border:"1px solid #7f1d1d",color:"#f87171",
                    }}>ignored</span>}
                  </div>
                  <div style={{color:"#e2e8f0",fontSize:10,marginTop:3,paddingLeft:14}}>
                    {d.ip}
                    {d.vendor && <> - {d.vendor}</>}
                    {d.model && <> - {d.model}</>}
                    {d.ports && <> - {d.ports.filter(p => p.oper_status === 1).length}/{d.ports.length} ports</>}
                  </div>
                </div>
                <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
                  <button
                    disabled={togglingIgnoreId === d.id}
                    onClick={() => toggleIgnored(d)}
                    title={d.ignored ? "Re-enable this device" : "Ignore this device"}
                    style={{
                      background:"none",
                      border: d.ignored ? "1px solid #164e63" : "1px solid #475569",
                      color: d.ignored ? "#22d3ee" : "#64748b",
                      borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,
                      opacity: togglingIgnoreId === d.id ? 0.5 : 1,
                    }}
                  >
                    {togglingIgnoreId === d.id ? "..." : d.ignored ? "Re-enable" : "Ignore"}
                  </button>
                  <button
                    onClick={() => {
                      setForm(f => ({ ...f, label: d.sys_name || d.ip, ip: d.ip, device_id: d.id }));
                      setEditState({ id: null, open: true });
                      setErr("");
                    }}
                    style={{
                      background:"none",border:"1px solid #854d0e",color:"#fbbf24",
                      borderRadius:4,padding:"2px 10px",cursor:"pointer",fontSize:10,
                      fontFamily:"'Inter', system-ui, sans-serif",flexShrink:0,
                    }}
                  >+ Add credentials</button>
                </div>
              </div>
            ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default CredentialsTabContent;
