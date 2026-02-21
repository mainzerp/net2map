import { useState, useRef } from "react";
import { speedLabel, speedColor } from "../api.js";

// ── Port ─────────────────────────────────────────────────────────────────────
export default function Port({ port, portKey, portLinkMap, selectedLink, onPortClick, cableColor }) {
  const [hov, setHov] = useState(false);
  const ref = useRef(null);
  const [pos, setPos] = useState({ top:0, left:0 });

  const active   = port.oper_status === 1;
  const spd      = port.speed_mbps;
  const base     = !active ? "#1e293b" : speedColor(spd);
  const hasDev   = !!(port.peer_ip || port.peer_mac);

  const linkEntry = portLinkMap && portKey ? portLinkMap[portKey] : null;
  const isLinked  = !!linkEntry;
  const cc        = cableColor || "#22d3ee";
  let hl = null;
  if (selectedLink && portKey) {
    const sKey = `${selectedLink.local_ip}:${selectedLink.local_port}`;
    const dKey = `${selectedLink.remote_ip}:${selectedLink.remote_port}`;
    if (portKey === sKey) hl = "from";
    else if (portKey === dKey) hl = "to";
    else if (isLinked) hl = "dim";
  }

  const bg     = hl==="from"||hl==="to" ? `${cc}28` : hl==="dim" ? "#0b0f18" : isLinked && !hl ? `${cc}12` : active ? base : "#0f172a";
  const border = hl==="from"||hl==="to" ? cc : isLinked ? cc : base;
  const shadow = hl==="from"||hl==="to"
    ? `0 0 12px ${cc}, 0 0 4px ${cc}`
    : isLinked && !hl ? `0 0 6px ${cc}` : hov && (hasDev || isLinked) ? `0 0 7px ${base}` : active ? `0 0 2px ${base}55` : "none";

  const handleClick = () => {
    if (!isLinked || !onPortClick) return;
    const { link } = linkEntry;
    const isSame = selectedLink?.local_ip===link.local_ip && selectedLink?.local_port===link.local_port;
    onPortClick(isSame ? null : link);
  };

  return (
    <>
      <div
        ref={ref}
        data-pkey={portKey || ""}
        onClick={handleClick}
        onMouseEnter={() => {
          if (!hasDev && !isLinked) return;
          const r = ref.current.getBoundingClientRect();
          setPos({ top: r.bottom + 8, left: r.left + r.width / 2 });
          setHov(true);
        }}
        onMouseLeave={() => setHov(false)}
        style={{ flexShrink:0, opacity: hl==="dim" ? 0.22 : 1, transition:"opacity 0.18s", cursor: isLinked ? "pointer" : "default" }}
      >
        <div title={port.if_descr} style={{
          width:44, height:24, borderRadius:2,
          backgroundColor: bg,
          border:`1px solid ${border}`,
          boxShadow: shadow,
          display:"flex", alignItems:"center", justifyContent:"center",
          transition:"all 0.13s", position:"relative",
        }}>
          {isLinked && (
            <div style={{
              position:"absolute", top:-3, right:-3,
              width:6, height:6, borderRadius:"50%",
              backgroundColor: cc, border:"1px solid #020817",
              boxShadow:`0 0 5px ${cc}`,
            }}/>
          )}
          <span style={{
            fontSize:9, fontWeight:700,
            color: hl ? "rgba(255,255,255,0.95)"
                 : (isLinked && !hl) ? "#e2e8f0"
                 : active ? "rgba(0,0,0,0.75)"
                 : "#64748b",
            fontFamily:"monospace", lineHeight:1, userSelect:"none",
          }}>{port.if_index}</span>
        </div>
      </div>

      {hov && (hasDev || isLinked) && (
        <div style={{
          position:"fixed", top:pos.top, left:pos.left,
          transform:"translateX(-50%)", zIndex:9999,
          backgroundColor:"#0f172a", border:`1px solid ${isLinked ? cc+"55" : "#334155"}`,
          borderRadius:8, padding:"10px 14px", minWidth:240,
          pointerEvents:"none",
          fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"#94a3b8",
          boxShadow:`0 8px 32px rgba(0,0,0,0.7), 0 0 12px ${cc}18`,
        }}>
          {isLinked && (
            <div style={{marginBottom: hasDev ? 10 : 0, padding:"5px 8px",
              backgroundColor:`${cc}12`, border:`1px solid ${cc}33`,
              borderRadius:5, color:cc, fontSize:10}}>
              <div style={{fontWeight:600, marginBottom:3}}>Switch-to-switch - {linkEntry.link.speed_label}</div>
              <div style={{color:"#94a3b8"}}>
                {linkEntry.link.local_ip} {linkEntry.link.local_port} {"<->"} {linkEntry.link.remote_port} {linkEntry.link.remote_ip}
              </div>
              <div style={{color:"#475569", marginTop:2, fontSize:9}}>
                Click to {selectedLink?"deselect":"highlight"}
              </div>
            </div>
          )}
          {hasDev && (
            <div style={{display:"grid",gridTemplateColumns:"60px 1fr",rowGap:3}}>
              {port.peer_ip   && <><span style={{color:"#475569"}}>IP</span>   <span style={{color:"#7dd3fc"}}>{port.peer_ip}</span></>}
              {port.peer_host && <><span style={{color:"#475569"}}>Host</span> <span style={{color:"#e2e8f0"}}>{port.peer_host}</span></>}
              {port.peer_mac  && <><span style={{color:"#475569"}}>MAC</span>  <span>{port.peer_mac}</span></>}
              <span style={{color:"#475569"}}>Port</span> <span>{port.if_descr}</span>
              <span style={{color:"#475569"}}>Speed</span><span style={{color:speedColor(spd)}}>{speedLabel(spd)}</span>
              {port.vlan > 0 && <><span style={{color:"#475569"}}>VLAN</span><span>{port.vlan}</span></>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
