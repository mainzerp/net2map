import { useState, useRef } from "react";

const CABLE_COLORS = ["#f472b6","#fb923c","#a78bfa","#34d399","#fbbf24","#60a5fa","#f87171","#e879f9"];

// ─── Mock Data ────────────────────────────────────────────────────────────────
const RACKS = [
  { id: "rack-a", label: "Rack A", room: "RZ-01", x: 180, y: 140 },
  { id: "rack-b", label: "Rack B", room: "RZ-01", x: 480, y: 100 },
  { id: "rack-c", label: "Rack C", room: "RZ-02", x: 720, y: 250 },
  { id: "rack-d", label: "Rack D", room: "RZ-02", x: 380, y: 340 },
  { id: "rack-e", label: "Rack E", room: "RZ-03", x: 620, y: 430 },
];
const MAP_LINKS = [
  { from: "rack-a", to: "rack-b", speed: "10G" },
  { from: "rack-b", to: "rack-c", speed: "10G" },
  { from: "rack-b", to: "rack-d", speed: "1G"  },
  { from: "rack-d", to: "rack-e", speed: "10G" },
  { from: "rack-c", to: "rack-e", speed: "1G"  },
  { from: "rack-a", to: "rack-d", speed: "1G"  },
];

const DEVICE_TYPES = ["server","ap","printer","phone","camera","unknown"];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

function makePorts(count, uplinks = []) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    label: `1/1/${i + 1}`,
    active: Math.random() > 0.35,
    speed:  i < uplinks.length ? "10G" : Math.random() > 0.5 ? "1G" : "100M",
    uplink: i < uplinks.length,
    device: Math.random() > 0.4 ? {
      hostname: `host-${String(i+1).padStart(2,"0")}.corp.local`,
      ip: `10.${Math.floor(Math.random()*5)+1}.${Math.floor(Math.random()*20)}.${Math.floor(Math.random()*254)+1}`,
      mac: Array.from({length:6},()=>Math.floor(Math.random()*256).toString(16).padStart(2,"0")).join(":"),
      type: rnd(DEVICE_TYPES),
      vlan: rnd([10,20,30,40,100]),
    } : null,
  }));
}

const SWITCHES_BY_RACK = {
  "rack-a": {
    switches: [
      { id:"sw-a1", model:"Aruba CX 6300M", role:"Core",         tor:true,  ports:makePorts(24,[0,1]) },
      { id:"sw-a2", model:"Aruba CX 6200F", role:"Access",        tor:false, ports:makePorts(48,[0])   },
    ],
    internalLinks: [
      { from:"sw-a1", fromPort:3, to:"sw-a2", toPort:1, speed:"10G" },
      { from:"sw-a1", fromPort:4, to:"sw-a2", toPort:2, speed:"10G" },
    ],
  },
  "rack-b": {
    switches: [
      { id:"sw-b1", model:"Aruba CX 8360",  role:"Core",         tor:true,  ports:makePorts(32,[0,1,2]) },
    ],
    internalLinks: [],
  },
  "rack-c": {
    switches: [
      { id:"sw-c1", model:"Aruba CX 6300F", role:"Distribution", tor:true,  ports:makePorts(24,[0,1]) },
      { id:"sw-c2", model:"Aruba CX 6200M", role:"Access",        tor:false, ports:makePorts(48,[0])   },
    ],
    internalLinks: [
      { from:"sw-c1", fromPort:3, to:"sw-c2", toPort:1, speed:"10G" },
    ],
  },
  "rack-d": {
    switches: [
      { id:"sw-d1", model:"Aruba CX 6200F", role:"Access",        tor:true,  ports:makePorts(48,[0,1]) },
    ],
    internalLinks: [],
  },
  "rack-e": {
    switches: [
      { id:"sw-e1", model:"Aruba CX 6300M", role:"Distribution", tor:true,  ports:makePorts(24,[0])   },
      { id:"sw-e2", model:"Aruba CX 6200F", role:"Access",        tor:false, ports:makePorts(48,[0])   },
    ],
    internalLinks: [
      { from:"sw-e1", fromPort:2, to:"sw-e2", toPort:1, speed:"10G" },
    ],
  },
};

function buildPortLinkMap(links) {
  const m = {};
  links.forEach(l => {
    m[`${l.from}:${l.fromPort}`] = { link:l, role:"from" };
    m[`${l.to}:${l.toPort}`]     = { link:l, role:"to"   };
  });
  return m;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ICONS = { server:"[S]", ap:"[AP]", printer:"[P]", phone:"[T]", camera:"[C]", unknown:"[?]" };
const DevIcon = ({ type, size=12 }) => <span style={{fontSize:size}}>{ICONS[type]||"[?]"}</span>;

// ─── Port ─────────────────────────────────────────────────────────────────────
function Port({ port, swId, portLinkMap, selectedLink, onPortClick, cableColor }) {
  const [hovered, setHovered] = useState(false);
  const ref   = useRef(null);
  const [pos, setPos] = useState({ top:0, left:0 });

  const key       = `${swId}:${port.id}`;
  const linkEntry = portLinkMap[key];
  const isLinked  = !!linkEntry;
  const cc        = cableColor || "#22d3ee";

  let hl = null;
  if (selectedLink) {
    if (key === `${selectedLink.from}:${selectedLink.fromPort}`) hl = "from";
    else if (key === `${selectedLink.to}:${selectedLink.toPort}`) hl = "to";
    else hl = "dim";
  }

  const base = !port.active ? "#1e293b"
    : port.uplink ? "#f59e0b"
    : port.speed === "10G" ? "#22d3ee" : "#22c55e";

  const bg     = hl==="from"||hl==="to" ? `${cc}28` : hl==="dim" ? "#0b0f18" : port.active ? base : "#0f172a";
  const border = hl==="from"||hl==="to" ? cc : isLinked ? `${cc}66` : base;
  const shadow = hl==="from"||hl==="to"
    ? `0 0 10px ${cc}, 0 0 3px ${cc}`
    : hovered && (port.device||isLinked) ? `0 0 7px ${base}` : port.active ? `0 0 2px ${base}55` : "none";

  const handleMouseEnter = () => {
    if (!port.device && !isLinked) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ top: r.bottom+8, left: r.left+r.width/2 });
    setHovered(true);
  };

  const handleClick = () => {
    if (!isLinked) return;
    const { link } = linkEntry;
    const same = selectedLink?.from===link.from && selectedLink?.fromPort===link.fromPort;
    onPortClick(same ? null : link);
  };

  return (
    <>
      <div
        ref={ref}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setHovered(false)}
        style={{
          flexShrink:0, cursor: isLinked?"pointer":"default",
          opacity: hl==="dim" ? 0.22 : 1,
          transition:"opacity 0.18s",
        }}
      >
        <div style={{
          width:18, height:30, borderRadius:2,
          backgroundColor:bg, border:`1px solid ${border}`,
          boxShadow:shadow, transition:"all 0.13s",
          display:"flex", alignItems:"center", justifyContent:"center",
          position:"relative",
        }}>
          {/* cable dot */}
          {isLinked && (
            <div style={{
              position:"absolute", top:-3, right:-3,
              width:5, height:5, borderRadius:"50%",
              backgroundColor: cc, border:"1px solid #020817",
              boxShadow:`0 0 4px ${cc}`,
            }}/>
          )}
          <span style={{
            fontSize:6.5, fontWeight:700,
            color: hl ? "rgba(255,255,255,0.8)" : port.active ? "rgba(0,0,0,0.55)" : "#475569",
            fontFamily:"monospace", lineHeight:1, userSelect:"none",
            writingMode:"vertical-rl", transform:"rotate(180deg)",
          }}>{port.id}</span>
        </div>
      </div>

      {/* Tooltip */}
      {hovered && (port.device||isLinked) && (
        <div style={{
          position:"fixed", top:pos.top, left:pos.left,
          transform:"translateX(-50%)", zIndex:9999,
          backgroundColor:"#0f172a", border:`1px solid ${isLinked?cc+"55":"#334155"}`,
          borderRadius:8, padding:"10px 14px", minWidth:240,
          pointerEvents:"none",
          fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"#94a3b8",
          boxShadow:`0 8px 32px rgba(0,0,0,0.7), 0 0 12px ${cc}18`,
        }}>
          {isLinked && (
            <div style={{ marginBottom: port.device?10:0, padding:"5px 8px",
              backgroundColor:`${cc}12`, border:`1px solid ${cc}33`,
              borderRadius:5, color:cc, fontSize:10 }}>
              <div style={{fontWeight:600, marginBottom:3}}>Switch-to-switch - {linkEntry.link.speed}</div>
              <div style={{color:"#94a3b8"}}>
                {linkEntry.link.from} 1/1/{linkEntry.link.fromPort} {"<->"} 1/1/{linkEntry.link.toPort} {linkEntry.link.to}
              </div>
              <div style={{color:"#475569", marginTop:2, fontSize:9}}>
                Click to {selectedLink?"deselect":"highlight"}
              </div>
            </div>
          )}
          {port.device && (
            <>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
                <DevIcon type={port.device.type} size={14}/>
                <span style={{color:"#e2e8f0",fontWeight:"bold",fontSize:12}}>{port.device.hostname}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"60px 1fr",rowGap:3}}>
                <span style={{color:"#475569"}}>IP</span>    <span style={{color:"#7dd3fc"}}>{port.device.ip}</span>
                <span style={{color:"#475569"}}>MAC</span>   <span>{port.device.mac}</span>
                <span style={{color:"#475569"}}>Port</span>  <span>{port.label}</span>
                <span style={{color:"#475569"}}>Speed</span> <span>{port.speed}</span>
                <span style={{color:"#475569"}}>VLAN</span>  <span>{port.device.vlan}</span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ─── SwitchPanel ──────────────────────────────────────────────────────────────
function SwitchPanel({ sw, portLinkMap, selectedLink, onPortClick, linkColorMap }) {
  const [open, setOpen] = useState(true);
  const active = sw.ports.filter(p=>p.active).length;

  return (
    <div
      style={{
        backgroundColor:"#0f172a",
        border:`1px solid ${sw.tor?"#164e63":"#1e293b"}`,
        borderRadius:10, marginBottom:6, overflow:"hidden",
        boxShadow: sw.tor?"0 0 12px rgba(34,211,238,0.05)":"none",
      }}
    >
      <div onClick={()=>setOpen(!open)} style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", cursor:"pointer",
        borderRadius: open?"10px 10px 0 0":10,
        backgroundColor:"#0f172a", userSelect:"none",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",backgroundColor:"#22c55e",boxShadow:"0 0 6px #22c55e"}}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:"#e2e8f0",fontWeight:600,fontSize:13}}>{sw.model}</span>
              {sw.tor && (
                <span style={{fontSize:9,padding:"1px 6px",backgroundColor:"#083344",border:"1px solid #164e63",borderRadius:4,color:"#22d3ee",letterSpacing:1}}>ToR</span>
              )}
            </div>
            <div style={{color:"#475569",fontSize:11}}>{sw.role} - {active}/{sw.ports.length} ports active</div>
          </div>
        </div>
        <span style={{color:"#475569",fontSize:16}}>{open?"v":">"}</span>
      </div>

      {open && (
        <div style={{padding:"0 14px 12px"}}>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"flex-start"}}>
            {sw.ports.map(port => (
              <Port
                key={port.id}
                port={port}
                swId={sw.id}
                portLinkMap={portLinkMap}
                selectedLink={selectedLink}
                onPortClick={onPortClick}
                cableColor={linkColorMap[`${sw.id}:${port.id}`]}
              />
            ))}
          </div>
          <div style={{display:"flex",gap:14,marginTop:9,fontSize:10,color:"#475569",flexWrap:"wrap"}}>
            <span><span style={{color:"#22c55e"}}>■</span> 1G</span>
            <span><span style={{color:"#22d3ee"}}>■</span> 10G</span>
            <span><span style={{color:"#f59e0b"}}>■</span> Uplink</span>
            <span><span style={{color:"#1e293b"}}>■</span> inactive</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ActiveLinkBar ────────────────────────────────────────────────────────────
// ─── ActiveLinkBar ────────────────────────────────────────────────────────────
function ActiveLinkBar({ link, color, onClear }) {
  return (
    <div style={{
      marginBottom:10, padding:"9px 14px",
      backgroundColor:`${color}0e`, border:`1px solid ${color}44`,
      borderRadius:8, fontFamily:"monospace", fontSize:11,
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:8,
    }}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{color,fontSize:14}}>{"<->"}</span>
        <span style={{color:"#e2e8f0",fontWeight:600}}>Active connection</span>
        <span style={{color:"#64748b"}}>·</span>
        <span style={{color}}>{link.from}</span>
        <span style={{color:"#64748b"}}>1/1/{link.fromPort}</span>
        <span style={{color:"#94a3b8"}}>{"<->"}</span>
        <span style={{color:"#64748b"}}>1/1/{link.toPort}</span>
        <span style={{color}}>{link.to}</span>
        <span style={{padding:"1px 5px",backgroundColor:`${color}18`,border:`1px solid ${color}33`,borderRadius:4,color,fontSize:9}}>{link.speed}</span>
      </div>
      <button onClick={onClear} style={{background:"none",border:`1px solid ${color}44`,color,borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:11,flexShrink:0}}>X</button>
    </div>
  );
}

// ─── RackDetail ───────────────────────────────────────────────────────────────
function RackDetail({ rack, onClose }) {
  const [selectedLink, setSelectedLink] = useState(null);

  const rackData = SWITCHES_BY_RACK[rack.id] || { switches:[], internalLinks:[] };
  const { switches, internalLinks } = rackData;
  const portLinkMap = buildPortLinkMap(internalLinks);

  const linkColorByKey = {};
  internalLinks.forEach((l, i) => {
    linkColorByKey[`${l.from}:${l.fromPort}`] = CABLE_COLORS[i % CABLE_COLORS.length];
  });

  const linkColorMap = {};
  internalLinks.forEach((l, i) => {
    const c = CABLE_COLORS[i % CABLE_COLORS.length];
    linkColorMap[`${l.from}:${l.fromPort}`] = c;
    linkColorMap[`${l.to}:${l.toPort}`]     = c;
  });

  const selColor = selectedLink
    ? linkColorByKey[`${selectedLink.from}:${selectedLink.fromPort}`] || "#22d3ee"
    : null;

  const toggle = (l) => {
    if (!l) { setSelectedLink(null); return; }
    setSelectedLink(p => p?.from===l.from && p?.fromPort===l.fromPort ? null : l);
  };

  return (
    <div style={{
      position:"fixed", right:0, top:0, bottom:0, width:500,
      backgroundColor:"#020817", borderLeft:"1px solid #1e293b",
      zIndex:100, display:"flex", flexDirection:"column",
      fontFamily:"'JetBrains Mono',monospace",
      boxShadow:"-8px 0 40px rgba(0,0,0,0.6)",
      animation:"slideIn 0.2s ease",
    }}>
      <style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>

      {/* Header */}
      <div style={{
        padding:"16px 20px", borderBottom:"1px solid #1e293b",
        display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0,
      }}>
        <div>
          <div style={{color:"#e2e8f0",fontWeight:700,fontSize:16}}>{rack.label}</div>
          <div style={{color:"#475569",fontSize:11,marginTop:2}}>
            {rack.room} - {switches.length} switches - {internalLinks.length} internal link{internalLinks.length!==1?"s":""}
          </div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"1px solid #1e293b",color:"#64748b",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:16}}>X</button>
      </div>

      {/* Active link bar */}
      {selectedLink && (
        <div style={{padding:"10px 20px 0",flexShrink:0}}>
          <ActiveLinkBar link={selectedLink} color={selColor} onClear={()=>setSelectedLink(null)}/>
        </div>
      )}

      {/* Scrollable content */}
      <div
        style={{
          flex:1, overflowY:"auto", overflowX:"hidden",
          padding:"12px 20px",
          position:"relative",
        }}
      >
        {switches.map(sw => (
          <div key={sw.id}>
            <SwitchPanel
              sw={sw}
              portLinkMap={portLinkMap}
              selectedLink={selectedLink}
              onPortClick={toggle}
              linkColorMap={linkColorMap}
            />
          </div>
        ))}

        {/* Cable legend */}
        {internalLinks.length > 0 && (
          <div style={{
            marginTop:14, padding:"8px 12px",
            backgroundColor:"#0c0f18", borderRadius:8, border:"1px solid #1e293b",
          }}>
            <div style={{color:"#334155",fontSize:10,marginBottom:6,letterSpacing:1}}>CABLE MAP</div>
            {internalLinks.map((l,i) => {
              const c = CABLE_COLORS[i%CABLE_COLORS.length];
              const isSel = selectedLink?.from===l.from && selectedLink?.fromPort===l.fromPort;
              return (
                <div key={i} onClick={()=>toggle(l)} style={{
                  display:"flex", alignItems:"center", gap:8, marginBottom:4,
                  cursor:"pointer", padding:"3px 6px", borderRadius:4,
                  backgroundColor: isSel ? `${c}14` : "transparent",
                  transition:"background 0.15s",
                }}>
                  <div style={{width:24,height:2,backgroundColor:c,borderRadius:2,flexShrink:0}}/>
                  <span style={{color:"#64748b",fontSize:10}}>
                    {l.from}&nbsp;1/1/{l.fromPort}&nbsp;{"<->"}&nbsp;1/1/{l.toPort}&nbsp;{l.to}
                  </span>
                  <span style={{
                    marginLeft:"auto", padding:"1px 5px", fontSize:9,
                    backgroundColor:`${c}18`, border:`1px solid ${c}33`,
                    borderRadius:3, color:c,
                  }}>{l.speed}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{padding:"8px 20px",borderTop:"1px solid #1e293b",fontSize:10,color:"#334155",textAlign:"center",flexShrink:0}}>
        Cable routing in right panel - Port (*) or cable map to highlight
      </div>
    </div>
  );
}

// ─── TopologyMap ──────────────────────────────────────────────────────────────
function TopologyMap({ onSelectRack, selectedRack }) {
  const W = 900, H = 550;
  const getR = id => RACKS.find(r=>r.id===id);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <radialGradient id="bg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor="#0f172a"/><stop offset="100%" stopColor="#020817"/>
        </radialGradient>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#0f172a" strokeWidth="1"/>
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#bg)" rx={12}/>
      <rect width={W} height={H} fill="url(#grid)" rx={12} opacity={0.6}/>
      {MAP_LINKS.map((l,i)=>{
        const a=getR(l.from),b=getR(l.to);
        const c=l.speed==="10G"?"#22d3ee":"#334155";
        return <g key={i}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={l.speed==="10G"?2:1} strokeOpacity={0.4}/>
          <text x={(a.x+b.x)/2} y={(a.y+b.y)/2-6} fill={c} fontSize={9} textAnchor="middle" opacity={0.7} fontFamily="monospace">{l.speed}</text>
        </g>;
      })}
      {RACKS.map(rack=>{
        const sel=selectedRack?.id===rack.id;
        const {switches=[]}=SWITCHES_BY_RACK[rack.id]||{};
        const tot=switches.reduce((s,sw)=>s+sw.ports.length,0);
        const act=switches.reduce((s,sw)=>s+sw.ports.filter(p=>p.active).length,0);
        return (
          <g key={rack.id} transform={`translate(${rack.x},${rack.y})`} onClick={()=>onSelectRack(rack)} style={{cursor:"pointer"}} filter={sel?"url(#glow)":undefined}>
            <circle r={38} fill="none" stroke={sel?"#22d3ee":"#1e293b"} strokeWidth={sel?2:1} strokeDasharray={sel?"none":"4 4"} opacity={sel?1:0.5}/>
            <circle r={28} fill={sel?"#0f2942":"#0f172a"} stroke={sel?"#22d3ee":"#334155"} strokeWidth={1.5}/>
            <text textAnchor="middle" dominantBaseline="middle" fontSize={14} y={-2} fontFamily="monospace">[R]</text>
            <text textAnchor="middle" y={18} fill={sel?"#22d3ee":"#94a3b8"} fontSize={10} fontFamily="monospace" fontWeight="bold">{rack.label}</text>
            <text textAnchor="middle" y={50} fill="#475569" fontSize={9} fontFamily="monospace">{act}/{tot} active</text>
            <text textAnchor="middle" y={60} fill="#334155" fontSize={8} fontFamily="monospace">{rack.room}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [selectedRack, setSelectedRack] = useState(null);
  return (
    <div style={{minHeight:"100vh",backgroundColor:"#020817",fontFamily:"'JetBrains Mono',monospace",color:"#e2e8f0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:#0f172a}
        ::-webkit-scrollbar-thumb{background:#1e293b;border-radius:4px}
      `}</style>

      <div style={{padding:"14px 24px",borderBottom:"1px solid #0f172a",display:"flex",alignItems:"center",justifyContent:"space-between",backgroundColor:"#020817"}}>
        <div>
          <span style={{color:"#22d3ee",fontWeight:700,fontSize:15}}>NetMap</span>
          <span style={{color:"#334155",fontSize:12,marginLeft:14}}>Aruba CX · SNMP Topology View</span>
        </div>
        <div style={{display:"flex",gap:20,fontSize:11,color:"#475569"}}>
          <span><span style={{color:"#22c55e"}}>●</span> {RACKS.length} Racks</span>
          <span><span style={{color:"#22d3ee"}}>●</span> {MAP_LINKS.filter(l=>l.speed==="10G").length} × 10G</span>
          <span><span style={{color:"#334155"}}>●</span> {MAP_LINKS.filter(l=>l.speed==="1G").length} × 1G</span>
        </div>
      </div>

      <div style={{padding:24,marginRight:selectedRack?500:0,transition:"margin-right 0.25s ease"}}>
        <div style={{border:"1px solid #0f172a",borderRadius:12,overflow:"hidden"}}>
          <TopologyMap onSelectRack={r=>setSelectedRack(p=>p?.id===r.id?null:r)} selectedRack={selectedRack}/>
        </div>
        {!selectedRack && (
          <p style={{textAlign:"center",color:"#334155",fontSize:11,marginTop:12}}>
            Click on rack to view switches with cable routing in right panel
          </p>
        )}
      </div>

      {selectedRack && <RackDetail rack={selectedRack} onClose={()=>setSelectedRack(null)}/>}
    </div>
  );
}
