import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap, normPort } from "../../api.js";
import SwitchPanel from "../SwitchPanel.jsx";

// ── RackDetail ───────────────────────────────────────────────────────────────
function RackDetail({ rack, allRacks, switchClasses, switchModels, topologyLinks, deviceOrder, onReorder, onClose, onRename, onMoveDevice, onUpdateDeviceMeta, rackPairColorMap, selectedLink, onLinkSelect }) {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(rack.label);
  // selectedLink is lifted to MapPage; fall back to local state if not provided
  const [localSelectedLink, setLocalSelectedLink] = useState(null);
  const resolvedSelectedLink = selectedLink !== undefined ? selectedLink : localSelectedLink;
  const setSelectedLink = onLinkSelect || setLocalSelectedLink;
  const totalPorts  = rack.devices.reduce((s,d) => s + (d.ports || []).length, 0);
  const activePorts = rack.devices.reduce((s,d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
  const otherRacks  = (allRacks || []).filter(r => r.id !== rack.id);

  // Compute panel width based on max ports_per_row across devices
  const maxPPR = useMemo(() => {
    let m = 24;
    rack.devices.forEach(d => { if (d.ports_per_row && d.ports_per_row > m) m = d.ports_per_row; });
    return m;
  }, [rack.devices]);
  // Port = 34px + 2px gap = 36px per port column
  // Chrome: content padding (40) + scrollbar (6) + reorder btns (23) + SwitchPanel border (2) + SwitchPanel padding (28) + extra (1) = 100px
  const panelWidth = Math.max(520, maxPPR * 36 + 100);

  const commitRename = () => {
    if (nameInput.trim() && nameInput.trim() !== rack.label) onRename?.(nameInput.trim());
    setEditing(false);
  };

  const sortGroup = useCallback((devices, groupKey) => {
    const order = (deviceOrder || {})[groupKey] || [];
    if (!order.length) return devices;
    return [...devices].sort((a, b) => {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [deviceOrder]);

  const torDevices    = useMemo(() => sortGroup(rack.devices.filter(d => d.class_id === 1 || (!d.class_id && d.vendor === "fs")),    "tor"),    [rack.devices, sortGroup]);
  const accessDevices = useMemo(() => sortGroup(rack.devices.filter(d => d.class_id === 2 || (!d.class_id && d.vendor === "aruba_cx")), "access"), [rack.devices, sortGroup]);
  const otherDevices  = useMemo(() => rack.devices.filter(d => d.class_id == null && d.vendor !== "fs" && d.vendor !== "aruba_cx"), [rack.devices]);

  const classMap = useMemo(() => Object.fromEntries((switchClasses || []).map(c => [c.id, c])), [switchClasses]);
  const modelMap = useMemo(() => Object.fromEntries((switchModels || []).map(m => [m.id, m])), [switchModels]);

  const { uplinks, trunks, external } = useMemo(() => {
    const rackIps  = new Set(rack.devices.map(d => d.ip));
    const devByIp  = Object.fromEntries(rack.devices.map(d => [d.ip, d]));
    const ipToRack = {};
    (allRacks || []).forEach(r => { (r.devices || []).forEach(d => { ipToRack[d.ip] = r; }); });

    const seenIntra    = new Set();
    const seenExternal = new Set();
    const intraAll = [];
    const external = [];

    (topologyLinks || []).forEach(l => {
      const localHere  = rackIps.has(l.local_ip);
      const remoteHere = rackIps.has(l.remote_ip);
      // Use port-level key to preserve multiple physical links between the same switch pair
      const portKey = [l.local_ip + ":" + l.local_port, l.remote_ip + ":" + l.remote_port].sort().join("|");
      if (localHere && remoteHere) {
        if (!seenIntra.has(portKey)) { seenIntra.add(portKey); intraAll.push(l); }
      } else if (localHere || remoteHere) {
        if (!seenExternal.has(portKey)) {
          seenExternal.add(portKey);
          const norm = localHere ? l : { ...l,
            local_ip: l.remote_ip, local_port: l.remote_port,
            remote_ip: l.local_ip, remote_port: l.local_port };
          external.push({ ...norm, remoteRack: ipToRack[norm.remote_ip] });
        }
      }
    });

    const uplinks = intraAll.filter(l => {
      const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
      // Different classes, or both unclassified → show as uplink
      return a?.class_id !== b?.class_id || (a?.class_id == null && b?.class_id == null);
    });
    const trunks = intraAll.filter(l => {
      const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
      return a?.class_id != null && a?.class_id === b?.class_id;
    });
    return { uplinks, trunks, external };
  }, [rack.devices, topologyLinks, allRacks]);

  const devByIp = useMemo(() => Object.fromEntries(rack.devices.map(d => [d.ip, d])), [rack.devices]);

  const allIntraLinks = useMemo(() => [...uplinks, ...trunks], [uplinks, trunks]);
  // Include external links so inter-rack ports also appear in portLinkMap / linkColorMap
  const allVisibleLinks = useMemo(() => [...allIntraLinks, ...external], [allIntraLinks, external]);
  const portLinkMap   = useMemo(() => buildPortLinkMap(allVisibleLinks), [allVisibleLinks]);

  // Set of port keys for ports connecting to other racks (used for prominent styling)
  const interRackPortKeys = useMemo(() => {
    const s = new Set();
    external.forEach(l => {
      s.add(`${l.local_ip}:${normPort(l.local_port)}`);
      s.add(`${l.remote_ip}:${normPort(l.remote_port)}`);
    });
    return s;
  }, [external]);

  // Build ip -> rack_id map from all known racks
  const ipToRackId = useMemo(() => {
    const m = {};
    (allRacks || []).forEach(r => {
      (r.devices || []).forEach(d => { m[d.ip] = r.id ? String(r.id) : "__unassigned__"; });
    });
    return m;
  }, [allRacks]);

  const linkColorMap  = useMemo(() => {
    const m = {};
    // Prefer rack-pair color from MapPage (rackPairColorMap) for consistent colors
    // with the SVG lines.  Fall back to per-switch-pair CABLE_COLORS.
    const pairColors = {};
    let colorIdx = 0;
    allVisibleLinks.forEach(l => {
      const pairKey = [l.local_ip, l.remote_ip].sort().join("|");
      if (!(pairKey in pairColors)) {
        // Try to get the rack-pair color first
        const ra = ipToRackId[l.local_ip];
        const rb = ipToRackId[l.remote_ip];
        const rackKey = ra && rb ? [ra, rb].sort().join("|") : null;
        const rackColor = rackKey ? rackPairColorMap?.[rackKey] : null;
        pairColors[pairKey] = rackColor || CABLE_COLORS[colorIdx % CABLE_COLORS.length];
        if (!rackColor) colorIdx++;
      }
      const c = pairColors[pairKey];
      m[`${l.local_ip}:${normPort(l.local_port)}`]   = c;
      m[`${l.remote_ip}:${normPort(l.remote_port)}`] = c;
    });
    return m;
  }, [allVisibleLinks, ipToRackId, rackPairColorMap]);
  const selColor  = resolvedSelectedLink ? (linkColorMap[`${resolvedSelectedLink.local_ip}:${normPort(resolvedSelectedLink.local_port)}`] || "#22d3ee") : null;
  const toggleLink = useCallback((l) =>
    setSelectedLink(p => p?.local_ip===l?.local_ip && p?.local_port===l?.local_port ? null : l),
  [setSelectedLink]);

  const [linkLine, setLinkLine] = useState(null);
  const scrollRef = useRef(null);
  const panelHeaderRef = useRef(null);

  useEffect(() => {
    if (!resolvedSelectedLink) { setLinkLine(null); return; }
    const computeLine = () => {
      const fromKey = `${resolvedSelectedLink.local_ip}:${normPort(resolvedSelectedLink.local_port)}`;
      const toKey   = `${resolvedSelectedLink.remote_ip}:${normPort(resolvedSelectedLink.remote_port)}`;
      const a = document.querySelector(`[data-pkey="${fromKey}"]`);
      const b = document.querySelector(`[data-pkey="${toKey}"]`);
      if (!a || !b) { setLinkLine(null); return; }
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const clipTop = panelHeaderRef.current?.getBoundingClientRect().bottom ?? 48;
      setLinkLine({
        x1: ra.left + ra.width / 2, y1: ra.top + ra.height / 2,
        x2: rb.left + rb.width / 2, y2: rb.top + rb.height / 2,
        clipTop,
      });
    };
    computeLine();
    const el = scrollRef.current;
    if (el) el.addEventListener("scroll", computeLine, { passive: true });
    return () => { if (el) el.removeEventListener("scroll", computeLine); };
  }, [resolvedSelectedLink]);

  const renderGroup = (devices, groupKey) => devices.map((d, idx) => (
    <div key={d.id} style={{display:"flex",alignItems:"flex-start",gap:5,marginBottom:4}}>
      <div style={{display:"flex",flexDirection:"column",gap:2,paddingTop:8,flexShrink:0}}>
        <button
          onClick={() => onReorder?.(d.id, "up", groupKey)}
          disabled={idx === 0}
          style={{
            background:"none", border:"1px solid #1e293b",
            color: idx === 0 ? "#1e293b" : "#475569",
            borderRadius:3, width:18, height:18,
            cursor: idx === 0 ? "default" : "pointer",
            fontSize:10, lineHeight:1, padding:0, display:"flex",
            alignItems:"center", justifyContent:"center",
          }}>^</button>
        <button
          onClick={() => onReorder?.(d.id, "down", groupKey)}
          disabled={idx === devices.length - 1}
          style={{
            background:"none", border:"1px solid #1e293b",
            color: idx === devices.length - 1 ? "#1e293b" : "#475569",
            borderRadius:3, width:18, height:18,
            cursor: idx === devices.length - 1 ? "default" : "pointer",
            fontSize:10, lineHeight:1, padding:0, display:"flex",
            alignItems:"center", justifyContent:"center",
          }}>v</button>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <SwitchPanel device={d} otherRacks={otherRacks} onMove={onMoveDevice}
          onUpdateMeta={onUpdateDeviceMeta}
          portLinkMap={portLinkMap} selectedLink={resolvedSelectedLink}
          onPortClick={toggleLink} linkColorMap={linkColorMap}
          interRackPortKeys={interRackPortKeys}
          switchClass={d.class_id ? classMap[d.class_id] : null}
          switchModel={d.model_id ? modelMap[d.model_id] : null}/>
      </div>
    </div>
  ));

  const renderLink = (l, i, accentColor) => {
    const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
    const isSel = resolvedSelectedLink?.local_ip===l.local_ip && resolvedSelectedLink?.local_port===l.local_port
               || resolvedSelectedLink?.remote_ip===l.local_ip && resolvedSelectedLink?.remote_port===l.local_port;
    const bg = isSel ? `${accentColor}14` : "transparent";
    return (
      <div
        key={i}
        onClick={() => toggleLink(l)}
        style={{
          display:"grid", gridTemplateColumns:"1fr 64px 1fr",
          alignItems:"center", gap:0,
          padding:"6px 12px",
          borderBottom: "1px solid #0f172a",
          borderLeft: isSel ? `3px solid ${accentColor}` : "3px solid transparent",
          backgroundColor: bg, cursor:"pointer",
          fontSize:10, position:"relative",
          transition:"background 0.15s",
        }}>
        <div style={{minWidth:0,paddingRight:6}}>
          <div style={{
            color: isSel ? accentColor : (VENDOR_COLOR[a?.vendor]||"#94a3b8"),
            fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{VENDOR_ICON[a?.vendor]||"[--]"} {a?.sys_name || l.local_ip}</div>
          <div style={{color:"#64748b",fontSize:10,marginTop:1}}>{l.local_port}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <div style={{
            width:"100%", height: isSel ? 5 : 4, borderRadius:2,
            background:`linear-gradient(90deg, ${accentColor}cc, ${accentColor})`,
            boxShadow: isSel ? `0 0 10px ${accentColor}` : `0 0 6px ${accentColor}88`,
          }}/>
          <span style={{
            fontSize:10, color:accentColor, fontWeight:700,
            letterSpacing:"0.05em",
          }}>{l.speed_label}</span>
        </div>
        <div style={{minWidth:0,paddingLeft:6,textAlign:"right"}}>
          <div style={{
            color: isSel ? accentColor : (VENDOR_COLOR[b?.vendor]||"#94a3b8"),
            fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{b?.sys_name || l.remote_ip} {VENDOR_ICON[b?.vendor]||"[--]"}</div>
          <div style={{color:"#64748b",fontSize:10,marginTop:1}}>{l.remote_port}</div>
        </div>
      </div>
    );
  };

  return (
    <>
    <div style={{
      position:"fixed", right:0, top:48, bottom:0, width:panelWidth,
      backgroundColor:"#020817", borderLeft:"1px solid #1e293b",
      zIndex:100, display:"flex", flexDirection:"column",
      fontFamily:"'Inter', system-ui, sans-serif",
      boxShadow:"-8px 0 40px rgba(0,0,0,0.6)",
      animation:"slideIn 0.2s ease",
    }}>
      <style>{`
        @keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @keyframes dashFlow{to{stroke-dashoffset:-12}}
      `}</style>

      {/* Header */}
      <div ref={panelHeaderRef} style={{
        padding:"16px 20px", borderBottom:"1px solid #1e293b",
        display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0,
      }}>
        <div style={{flex:1,minWidth:0}}>
          {editing ? (
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <input
                autoFocus value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter")  commitRename();
                  if (e.key === "Escape") { setNameInput(rack.label); setEditing(false); }
                }}
                style={{
                  fontSize:15, fontWeight:700,
                  background:"#0f172a", border:"1px solid #22d3ee",
                  color:"#e2e8f0", borderRadius:5, padding:"3px 8px",
                  fontFamily:"inherit", outline:"none", width:180,
                }}
              />
              <button onClick={commitRename} style={{background:"#083344",border:"1px solid #164e63",color:"#22d3ee",borderRadius:5,padding:"3px 8px",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>OK</button>
              <button onClick={() => { setNameInput(rack.label); setEditing(false); }} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:5,padding:"3px 8px",cursor:"pointer",fontSize:11}}>X</button>
            </div>
          ) : (
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{color:"#e2e8f0",fontWeight:700,fontSize:16}}>{rack.label}</div>
              <button
                onClick={() => { setNameInput(rack.label); setEditing(true); }}
                title="Rename rack"
                style={{background:"none",border:"1px solid #1e293b",color:"#475569",borderRadius:4,padding:"2px 6px",cursor:"pointer",fontSize:11}}
              >Edit</button>
            </div>
          )}
          <div style={{color:"#475569",fontSize:11,marginTop:2,display:"flex",gap:10}}>
            <span>{rack.location}</span>
            <span>{activePorts}/{totalPorts} ports active</span>
          </div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:16,flexShrink:0}}>X</button>
      </div>

      {/* Content */}
      <div ref={scrollRef} style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:"12px 20px"}}>

        {torDevices.length > 0 && (
          <>
            <div style={{
              fontSize:10, color: classMap[1]?.color || "#22d3ee", marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:`1px solid ${classMap[1]?.color ? classMap[1].color+"44" : "#164e63"}`,height:0,display:"inline-block"}}/>
              {classMap[1]?.label || "Top-of-Rack"} ({torDevices.length})
              <span style={{flex:1,borderBottom:`1px solid ${classMap[1]?.color ? classMap[1].color+"44" : "#164e63"}`,height:0,display:"inline-block"}}/>
            </div>
            {renderGroup(torDevices, "tor")}
          </>
        )}

        {accessDevices.length > 0 && (
          <>
            <div style={{
              fontSize:10, color: classMap[2]?.color || "#f59e0b", marginTop:10, marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:`1px solid ${classMap[2]?.color ? classMap[2].color+"44" : "#78350f"}`,height:0,display:"inline-block"}}/>
              {classMap[2]?.label || "Access"} ({accessDevices.length})
              <span style={{flex:1,borderBottom:`1px solid ${classMap[2]?.color ? classMap[2].color+"44" : "#78350f"}`,height:0,display:"inline-block"}}/>
            </div>
            {renderGroup(accessDevices, "access")}
          </>
        )}

        {otherDevices.length > 0 && (
          <>
            <div style={{fontSize:10,color:"#475569",marginTop:10,marginBottom:6,letterSpacing:"0.08em",textTransform:"uppercase"}}>Other</div>
            {renderGroup(otherDevices, "other")}
          </>
        )}

        {uplinks.length > 0 && (
          <>
            <div style={{
              fontSize:10, color:"#4ade80", marginTop:16, marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:"1px solid #14532d",height:0,display:"inline-block"}}/>
              Uplinks ({uplinks.length})
              <span style={{flex:1,borderBottom:"1px solid #14532d",height:0,display:"inline-block"}}/>
            </div>
            <div style={{backgroundColor:"#080d18",border:"1px solid #1e293b",borderRadius:8,overflow:"hidden"}}>
              {uplinks.map((l, i) => renderLink(l, i, linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || CABLE_COLORS[i % CABLE_COLORS.length]))}
            </div>
          </>
        )}

        {trunks.length > 0 && (
          <>
            <div style={{
              fontSize:10, color:"#22d3ee", marginTop:12, marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:"1px solid #164e63",height:0,display:"inline-block"}}/>
              TOR Trunks ({trunks.length})
              <span style={{flex:1,borderBottom:"1px solid #164e63",height:0,display:"inline-block"}}/>
            </div>
            <div style={{backgroundColor:"#080d18",border:"1px solid #1e293b",borderRadius:8,overflow:"hidden"}}>
              {trunks.map((l, i) => renderLink(l, i, linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || "#22d3ee"))}
            </div>
          </>
        )}

        {external.length > 0 && (
          <>
            <div style={{
              fontSize:10, color:"#818cf8", marginTop:16, marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:"1px solid #312e81",height:0,display:"inline-block"}}/>
              Inter-Rack ({external.length})
              <span style={{flex:1,borderBottom:"1px solid #312e81",height:0,display:"inline-block"}}/>
            </div>
            <div style={{backgroundColor:"#080d18",border:"1px solid #1e293b",borderRadius:8,overflow:"hidden"}}>
              {external.map((l, i) => {
                const localDev = devByIp[l.local_ip];
                const remoteLabel = l.remoteRack?.label || l.remote_ip;
                const c = "#818cf8";
                return (
                  <div key={i} style={{
                    display:"grid", gridTemplateColumns:"1fr 80px 1fr",
                    alignItems:"center", gap:0,
                    padding:"6px 12px", borderBottom:"1px solid #0f172a", fontSize:10,
                  }}>
                    <div style={{minWidth:0,paddingRight:6}}>
                      <div style={{color:VENDOR_COLOR[localDev?.vendor]||"#94a3b8",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {VENDOR_ICON[localDev?.vendor]||"[--]"} {localDev?.sys_name || l.local_ip}
                      </div>
                      <div style={{color:"#64748b",fontSize:10,marginTop:1}}>{l.local_port}</div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                      <div style={{width:"100%",height:3,borderRadius:2,background:`linear-gradient(90deg,${c}99,${c})`,boxShadow:`0 0 5px ${c}66`}}/>
                      <span style={{fontSize:10,color:c,fontWeight:700,letterSpacing:"0.05em"}}>{l.speed_label}</span>
                    </div>
                    <div style={{minWidth:0,paddingLeft:6,textAlign:"right"}}>
                      <div style={{color:"#818cf8",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {remoteLabel}
                      </div>
                      <div style={{color:"#64748b",fontSize:10,marginTop:1}}>{l.remote_port}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {allIntraLinks.length > 0 && (
          <div style={{
            marginTop:14, padding:"8px 12px",
            backgroundColor:"#0c0f18", borderRadius:8, border:"1px solid #1e293b",
          }}>
            <div style={{color:"#334155",fontSize:10,marginBottom:6,letterSpacing:1,textTransform:"uppercase"}}>Cable Map</div>
            {allIntraLinks.map((l, i) => {
              const c = linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || CABLE_COLORS[i % CABLE_COLORS.length];
              const isSel = resolvedSelectedLink?.local_ip===l.local_ip && resolvedSelectedLink?.local_port===l.local_port;
              return (
                <div key={i} onClick={() => toggleLink(l)} style={{
                  display:"flex", alignItems:"center", gap:8, marginBottom:4,
                  cursor:"pointer", padding:"3px 6px", borderRadius:4,
                  backgroundColor: isSel ? `${c}14` : "transparent",
                  transition:"background 0.15s",
                }}>
                  <div style={{width:24,height:2,backgroundColor:c,borderRadius:2,flexShrink:0}}/>
                  <span style={{color:"#64748b",fontSize:10,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {devByIp[l.local_ip]?.sys_name||l.local_ip} {l.local_port} {"<->"} {l.remote_port} {devByIp[l.remote_ip]?.sys_name||l.remote_ip}
                  </span>
                  <span style={{
                    padding:"1px 5px", fontSize:10,
                    backgroundColor:`${c}18`, border:`1px solid ${c}33`,
                    borderRadius:3, color:c, flexShrink:0,
                  }}>{l.speed_label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{padding:"8px 20px",borderTop:"1px solid #1e293b",fontSize:10,color:"#334155",textAlign:"center",flexShrink:0}}>
        Click a port (*) or cable map row to highlight a connection
      </div>
    </div>

    {linkLine && selColor && (
      <svg style={{
        position:"fixed", left:0, top:0, width:"100vw", height:"100vh",
        pointerEvents:"none", zIndex:9998,
        clipPath:`inset(${linkLine.clipTop ?? 48}px 0 0 0)`,
      }}>
        <line x1={linkLine.x1} y1={linkLine.y1} x2={linkLine.x2} y2={linkLine.y2}
              stroke={selColor} strokeWidth={6} strokeOpacity={0.15} strokeLinecap="round"/>
        <line x1={linkLine.x1} y1={linkLine.y1} x2={linkLine.x2} y2={linkLine.y2}
              stroke={selColor} strokeWidth={2} strokeLinecap="round"
              strokeDasharray="7 5"
              style={{animation:"dashFlow 0.6s linear infinite"}}/>
        <circle cx={linkLine.x1} cy={linkLine.y1} r={5} fill={selColor} opacity={0.9}/>
        <circle cx={linkLine.x2} cy={linkLine.y2} r={5} fill={selColor} opacity={0.9}/>
      </svg>
    )}
    </>
  );
}

export default RackDetail;
