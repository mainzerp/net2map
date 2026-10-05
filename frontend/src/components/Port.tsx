import { useState, useRef, useEffect } from "react";
import { normPort } from "../api";
import { speedLabel, speedColor } from "../theme/visual";
import type { PortInfo, TopologyLink, PortLinkEntry } from "../types";
import PortDetailModal from "./PortDetailModal";

interface PortProps {
  port: PortInfo;
  portKey: string;
  portLinkMap: Record<string, PortLinkEntry> | null;
  selectedLink: TopologyLink | null;
  onPortClick: ((link: TopologyLink | null) => void) | null;
  cableColor?: string;
  interRack?: boolean;
  highlighted?: boolean;
}

// Translucent variant of any CSS color, including var(--token) fallbacks where
// appending a hex alpha suffix would produce invalid CSS.
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// ── Port ─────────────────────────────────────────────────────────────────────
export default function Port({ port, portKey, portLinkMap, selectedLink, onPortClick, cableColor, interRack, highlighted }: PortProps) {
  const [hov, setHov] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; flipY?: boolean }>({ top: 0, left: 0 });
  const [showModal, setShowModal] = useState(false);

  // Scroll into view when highlighted (deep-link from the Endpoints page).
  // The ring pulse lives in index.css (.port-ring-pulse, --port-highlight).
  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [highlighted]);

  const active   = port.oper_status === 1;
  const spd      = (port.speed_mbps ?? port.speed ?? 0);
  const base     = !active ? "var(--panel-2)" : speedColor(spd);
  const endpointCount = Number(port.endpoint_count || 0);
  const hasDev   = endpointCount > 0;

  const linkEntry = portLinkMap && portKey ? portLinkMap[portKey] : null;
  const isLinked  = !!linkEntry;
  const cc        = cableColor || "var(--accent)";
  let hl: "from" | "to" | "dim" | null = null;
  if (selectedLink && portKey) {
    const sKey = `${selectedLink.local_ip}:${normPort(selectedLink.local_port)}`;
    const dKey = `${selectedLink.remote_ip}:${normPort(selectedLink.remote_port)}`;
    if (portKey === sKey) hl = "from";
    else if (portKey === dKey) hl = "to";
    else if (isLinked) hl = "dim";
  }

  // Cartographic styling: selected link endpoints get a 1.5px solid ring in
  // the cable color over a tinted fill; linked ports a cable-color border and
  // a light tint; hover a 1px ring. No blurred glows.
  const isSelected = hl==="from"||hl==="to";
  const bg     = isSelected ? tint(cc, 16) : hl==="dim" ? "var(--surface)" : isLinked && !hl ? tint(cc, 7) : active ? base : "var(--panel)";
  const border = isSelected ? cc : isLinked ? cc : base;
  const shadow = isSelected
    ? `0 0 0 1.5px ${cc}`
    : hov && (hasDev || isLinked) ? `0 0 0 1px ${isLinked ? cc : base}` : "none";

  // Deep-link highlight: calm ring pulse (.port-ring-pulse in index.css,
  // static ring under prefers-reduced-motion).
  const highlightStyle: React.CSSProperties = highlighted ? {
    border: "2px solid var(--port-highlight)",
    zIndex: 10,
  } : {};

  const handleClick = () => {
    if (!isLinked || !onPortClick) return;
    const { link } = linkEntry!;
    const isSame = selectedLink?.local_ip===link.local_ip && normPort(selectedLink?.local_port ?? "")===normPort(link.local_port);
    onPortClick(isSame ? null : link);
  };

  return (
    <>
      <div
        ref={ref}
        data-pkey={portKey || ""}
        onClick={handleClick}
        onDoubleClick={() => { if (hasDev) setShowModal(true); }}
        onMouseEnter={() => {
          if (!hasDev && !isLinked) return;
          const r = ref.current!.getBoundingClientRect();
          const tipW = 260;
          const tipH = 120;
          let top = r.bottom + 8;
          let left = r.left + r.width / 2;
          let flipY = false;
          if (top + tipH > window.innerHeight) {
            top = r.top - 8;
            flipY = true;
          }
          if (left - tipW / 2 < 4) left = tipW / 2 + 4;
          else if (left + tipW / 2 > window.innerWidth - 4) left = window.innerWidth - tipW / 2 - 4;
          setPos({ top, left, flipY });
          setHov(true);
        }}
        onMouseLeave={() => setHov(false)}
        style={{ flexShrink:0, opacity: hl==="dim" ? 0.22 : 1, transition:"opacity 0.18s", cursor: isLinked ? "pointer" : "default" }}
      >
        <div title={port.if_descr} className={highlighted ? "port-ring-pulse" : undefined} style={{
          width:34, height: interRack ? 22 : 20, borderRadius:2,
          backgroundColor: bg,
          border:`1px solid ${border}`,
          borderTop: interRack && isLinked ? `2px solid ${cc}` : `1px solid ${border}`,
          boxShadow: shadow,
          display:"flex", alignItems:"center", justifyContent:"center",
          transition:"all 0.13s", position:"relative",
          ...highlightStyle,
        }}>
          {isLinked && (
            <div style={{
              position:"absolute", top: interRack ? -5 : -3, right: interRack ? -5 : -3,
              width: interRack ? 9 : 6, height: interRack ? 9 : 6, borderRadius:"50%",
              backgroundColor: cc, border:"1px solid var(--surface)",
            }}/>
          )}
          <span style={{
            fontSize:12, fontWeight:700,
            color: hl ? "var(--primary)"
                 : (isLinked && !hl) ? "var(--primary)"
                 : active ? "color-mix(in srgb, var(--sidebar) 85%, transparent)"
                 : "var(--muted)",
            fontFamily:"var(--font-mono)", lineHeight:1, userSelect:"none",
          }}>{port.if_index}</span>
        </div>
      </div>

      {hov && (hasDev || isLinked) && (
        <div style={{
          position:"fixed", top:pos.top, left:pos.left,
          transform: pos.flipY ? "translate(-50%, -100%)" : "translateX(-50%)", zIndex:9999,
          backgroundColor:"var(--panel)", border:`1px solid ${isLinked ? tint(cc, 33) : "var(--line-strong)"}`,
          borderRadius:8, padding:"10px 14px", minWidth:240,
          pointerEvents:"none",
          fontSize:12, color:"var(--muted)",
          boxShadow:"var(--shadow-raised)",
        }}>
          {isLinked && (
            <div style={{marginBottom: hasDev ? 10 : 0, padding:"5px 8px",
              backgroundColor: tint(cc, 7), border:`1px solid ${tint(cc, 20)}`,
              borderRadius:5, color:cc, fontSize:12}}>
              <div style={{fontWeight:600, marginBottom:3}}>Switch-to-switch - {linkEntry!.link.speed_label}</div>
              <div style={{color:"var(--muted)"}}>
                {linkEntry!.link.local_ip} {linkEntry!.link.local_port} {"<->"} {linkEntry!.link.remote_port} {linkEntry!.link.remote_ip}
              </div>
              <div style={{color:"var(--muted)", marginTop:2, fontSize:12, opacity:0.8}}>
                Click to {selectedLink?"deselect":"highlight"}
              </div>
            </div>
          )}
          {hasDev && (
            <div style={{display:"grid",gridTemplateColumns:"60px 1fr",rowGap:3}}>
              <span style={{color:"var(--muted)", opacity:0.8}}>Hosts</span><span style={{color:endpointCount > 1 ? "var(--accent)" : "var(--muted)"}}>{endpointCount}</span>
              <span style={{color:"var(--muted)", opacity:0.8}}>Port</span> <span>{port.if_descr}</span>
              <span style={{color:"var(--muted)", opacity:0.7}}>Speed</span><span style={{color:speedColor(spd)}}>{speedLabel(spd)}</span>
              {port.vlan != null && port.vlan > 0 && <><span style={{color:"var(--muted)", opacity:0.7}}>VLAN</span><span>{port.vlan}</span></>}
              {port.tagged_vlans && port.tagged_vlans.length > 0 && <><span style={{color:"var(--muted)", opacity:0.7}}>Tagged</span><span>{port.tagged_vlans.join(", ")}</span></>}
            </div>
          )}
        </div>
      )}
      {showModal && (
        <PortDetailModal
          port={port}
          // portKey is "<ip>:<port>" -- split on the LAST colon so IPv6
          // addresses (which contain colons) survive.
          switchIp={portKey.slice(0, Math.max(0, portKey.lastIndexOf(":")))}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}
