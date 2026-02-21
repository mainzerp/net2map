import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { api, API, CABLE_COLORS, VENDOR_LABEL, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap } from "../api.js";
import SwitchPanel from "../components/SwitchPanel.jsx";

// ── ActiveLinkBar ────────────────────────────────────────────────────────────
function ActiveLinkBar({ link, color, onClear }) {
  return (
    <div style={{
      marginBottom:10, padding:"9px 14px",
      backgroundColor:`${color}0e`, border:`1px solid ${color}44`,
      borderRadius:8, fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:8,
    }}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{color,fontSize:14}}>{"<->"}</span>
        <span style={{color:"#e2e8f0",fontWeight:600}}>Active connection</span>
        <span style={{color:"#64748b"}}>-</span>
        <span style={{color}}>{link.local_ip}</span>
        <span style={{color:"#64748b"}}>{link.local_port}</span>
        <span style={{color:"#94a3b8"}}>{"<->"}</span>
        <span style={{color:"#64748b"}}>{link.remote_port}</span>
        <span style={{color}}>{link.remote_ip}</span>
        <span style={{padding:"1px 5px",backgroundColor:`${color}18`,border:`1px solid ${color}33`,borderRadius:4,color,fontSize:9}}>{link.speed_label}</span>
      </div>
      <button onClick={onClear} style={{background:"none",border:`1px solid ${color}44`,color,borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:11,flexShrink:0}}>X</button>
    </div>
  );
}

// ── FilterBar ────────────────────────────────────────────────────────────────
function FilterBar({ racks, classes, filters, onFilterChange }) {
  const toggleRack = (rackId) => {
    onFilterChange(prev => {
      const current = prev.racks ? new Set(prev.racks) : new Set(racks.map(r => r.id));
      if (current.has(rackId)) current.delete(rackId);
      else current.add(rackId);
      return { ...prev, racks: current.size === racks.length ? null : current.size === 0 ? new Set() : current };
    });
  };
  const toggleClass = (classId) => {
    onFilterChange(prev => {
      const current = prev.classes ? new Set(prev.classes) : new Set(classes.map(c => c.id));
      if (current.has(classId)) current.delete(classId);
      else current.add(classId);
      return { ...prev, classes: current.size === classes.length ? null : current.size === 0 ? new Set() : current };
    });
  };
  const clearFilters = () => onFilterChange({ racks: null, classes: null });
  const hasFilters = filters.racks !== null || filters.classes !== null;

  if (racks.length === 0 && classes.length === 0) return null;

  const btnStyle = (active) => ({
    fontSize: 10, padding: "3px 8px", borderRadius: 4, cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif", border: "1px solid",
    borderColor: active ? "#164e63" : "#1e293b",
    backgroundColor: active ? "#083344" : "#0a0e18",
    color: active ? "#22d3ee" : "#475569",
    transition: "all 0.15s", userSelect: "none",
  });

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, marginBottom: 10,
      padding: "8px 12px", backgroundColor: "#020817",
      border: "1px solid #0f172a", borderRadius: 8,
      fontFamily: "'Inter', system-ui, sans-serif", flexWrap: "wrap",
    }}>
      {racks.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "#334155", letterSpacing: 1 }}>RACKS</span>
          {racks.map(r => {
            const active = !filters.racks || filters.racks.has(r.id);
            return (
              <button key={r.id} onClick={() => toggleRack(r.id)} style={btnStyle(active)}>
                {r.label}
              </button>
            );
          })}
        </div>
      )}
      {classes.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "#334155", letterSpacing: 1 }}>CLASSES</span>
          {classes.map(c => {
            const active = !filters.classes || filters.classes.has(c.id);
            return (
              <button key={c.id} onClick={() => toggleClass(c.id)} style={{
                ...btnStyle(active),
                borderColor: active ? `${c.color}66` : "#1e293b",
                backgroundColor: active ? `${c.color}18` : "#0a0e18",
                color: active ? c.color : "#475569",
              }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                  backgroundColor: c.color, marginRight: 4, verticalAlign: "middle",
                  opacity: active ? 1 : 0.3,
                }}/>
                {c.label}
              </button>
            );
          })}
        </div>
      )}
      {hasFilters && (
        <button onClick={clearFilters} style={{
          fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer",
          fontFamily: "'Inter', system-ui, sans-serif",
          border: "1px solid #7f1d1d", backgroundColor: "transparent",
          color: "#f87171",
        }}>Clear filters</button>
      )}
    </div>
  );
}


// ── TopologyMap (SVG) ─────────────────────────────────────────────────────────
function TopologyMap({ nodes, links, managedRacks, switchClasses, filters, onSelectRack, selectedRackId, onPositionChange, mapBgUrl, mapBgOpacity, mapBgScale, mapBgNat }) {
  const W = 900, H = 550;
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [positions, setPositions] = useState({});
  const [zoom, setZoom] = useState(() => {
    try {
      const s = localStorage.getItem("netmap-zoom");
      if (s) return JSON.parse(s);
    } catch {}
    return { scale:1, tx:0, ty:0 };
  });
  const [bgPan, setBgPan] = useState(null);

  useEffect(() => {
    localStorage.setItem("netmap-zoom", JSON.stringify(zoom));
  }, [zoom]);

  useEffect(() => {
    const pos = {};
    nodes.forEach(n => { pos[n.id] = { x: n.map_x, y: n.map_y }; });
    setPositions(pos);
  }, [nodes]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const pt  = el.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const sp = pt.matrixTransform(el.getScreenCTM().inverse());
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom(z => {
        const newScale = Math.max(0.15, Math.min(10, z.scale * factor));
        const ratio    = newScale / z.scale;
        return { scale: newScale, tx: sp.x - ratio * (sp.x - z.tx), ty: sp.y - ratio * (sp.y - z.ty) };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const racks = useMemo(() => {
    const map = {};
    (managedRacks || []).forEach(r => {
      map[r.id] = { id: r.id, label: r.label, location: `${r.label}${r.room ? " / " + r.room : ""}`, devices: [] };
    });
    const unassignedKey = "__unassigned__";
    nodes.forEach(node => {
      if (node.rack_id && map[node.rack_id]) {
        map[node.rack_id].devices.push(node);
      } else {
        if (!map[unassignedKey]) map[unassignedKey] = { id: unassignedKey, label: "Unassigned", location: "Unassigned", devices: [] };
        map[unassignedKey].devices.push(node);
      }
    });
    let result = Object.values(map).filter(r => r.devices.length > 0);
    if (filters?.racks) {
      result = result.filter(r => filters.racks.has(r.id));
    }
    if (filters?.classes) {
      result = result.map(r => ({
        ...r,
        devices: r.devices.filter(d => d.class_id && filters.classes.has(d.class_id)),
      })).filter(r => r.devices.length > 0);
    }
    return result;
  }, [nodes, managedRacks, filters]);

  const getRackCenter = useCallback((rack) => {
    const devs = rack.devices;
    if (!devs.length) return { x: 100, y: 100 };
    const xs = devs.map(d => (positions[d.id] ?? d).x ?? d.map_x);
    const ys = devs.map(d => (positions[d.id] ?? d).y ?? d.map_y);
    return {
      x: xs.reduce((a,b) => a+b, 0) / xs.length,
      y: ys.reduce((a,b) => a+b, 0) / ys.length,
    };
  }, [positions]);

  const ipToRackId = useMemo(() => {
    const map = {};
    racks.forEach(rack => rack.devices.forEach(d => { map[d.ip] = rack.id; }));
    return map;
  }, [racks]);

  const rackLinks = useMemo(() => {
    const seen = new Set();
    const result = [];
    links.forEach(l => {
      const ra = ipToRackId[l.local_ip];
      const rb = ipToRackId[l.remote_ip];
      if (!ra || !rb || ra === rb) return;
      const key = [ra, rb].sort().join("|");
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ key, from: ra, to: rb, speed: l.speed_label });
    });
    return result;
  }, [links, ipToRackId]);

  const svgPoint = (e) => {
    const svg = svgRef.current;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const toContent = (vp) => ({ x: (vp.x - zoom.tx) / zoom.scale, y: (vp.y - zoom.ty) / zoom.scale });

  const onMouseDown = (e, rack) => {
    e.stopPropagation();
    const p = toContent(svgPoint(e));
    const center = getRackCenter(rack);
    setDrag({ rackId: rack.id, devices: rack.devices, ox: p.x - center.x, oy: p.y - center.y, moved: false });
  };

  const onBgMouseDown = (e) => {
    const p = svgPoint(e);
    setBgPan({ startX: p.x, startY: p.y, startTx: zoom.tx, startTy: zoom.ty });
  };

  const onMouseMove = (e) => {
    if (bgPan) {
      const p = svgPoint(e);
      setZoom(z => ({ ...z, tx: bgPan.startTx + (p.x - bgPan.startX), ty: bgPan.startTy + (p.y - bgPan.startY) }));
      return;
    }
    if (!drag) return;
    const p = toContent(svgPoint(e));
    const newCx = p.x - drag.ox;
    const newCy = p.y - drag.oy;
    const devs = drag.devices;
    const oldCx = devs.reduce((s,d) => s + (positions[d.id]?.x ?? d.map_x), 0) / devs.length;
    const oldCy = devs.reduce((s,d) => s + (positions[d.id]?.y ?? d.map_y), 0) / devs.length;
    const dx = newCx - oldCx, dy = newCy - oldCy;
    setPositions(prev => {
      const next = { ...prev };
      devs.forEach(d => {
        next[d.id] = { x: (prev[d.id]?.x ?? d.map_x) + dx, y: (prev[d.id]?.y ?? d.map_y) + dy };
      });
      return next;
    });
    setDrag(prev => ({ ...prev, moved: true }));
  };

  const onMouseUp = (e, rack) => {
    if (bgPan) { setBgPan(null); return; }
    if (!drag) return;
    if (!drag.moved) {
      onSelectRack(rack);
    } else {
      rack.devices.forEach(d => {
        const pos = positions[d.id];
        if (pos) onPositionChange(d.id, pos.x, pos.y);
      });
    }
    setDrag(null);
  };

  const rackById = (id) => racks.find(r => r.id === id);

  const bgS  = mapBgScale ?? 1;
  const bgW  = W * bgS, bgH = H * bgS;
  const bgX  = W/2 - bgW/2, bgY = H/2 - bgH/2;
  const bgFit = useMemo(() => {
    if (!mapBgNat) return { x: bgX, y: bgY, w: bgW, h: bgH };
    const ratio = mapBgNat.w / mapBgNat.h;
    const boxRatio = bgW / bgH;
    if (ratio > boxRatio) {
      const fh = bgW / ratio;
      return { x: bgX, y: bgY + (bgH - fh) / 2, w: bgW, h: fh };
    } else {
      const fw = bgH * ratio;
      return { x: bgX + (bgW - fw) / 2, y: bgY, w: fw, h: bgH };
    }
  }, [mapBgNat, bgX, bgY, bgW, bgH]);

  return (
    <svg
      ref={svgRef}
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display:"block", cursor: drag ? "grabbing" : bgPan ? "grabbing" : "default" }}
      onMouseMove={onMouseMove}
      onMouseUp={() => { setDrag(null); setBgPan(null); }}
      onMouseLeave={() => { setDrag(null); setBgPan(null); }}
    >
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <radialGradient id="bg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor="#0f172a"/><stop offset="100%" stopColor="#020817"/>
        </radialGradient>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#0f172a" strokeWidth="1"/>
        </pattern>
        {mapBgUrl && (
          <clipPath id="bgClip">
            <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h} rx={18} ry={18}/>
          </clipPath>
        )}
      </defs>
      <rect width={W} height={H} fill="url(#bg)" rx={12}
            onMouseDown={onBgMouseDown} style={{cursor: bgPan ? "grabbing" : "grab"}}/>
      <rect width={W} height={H} fill="url(#grid)" rx={12} opacity={0.6}
            onMouseDown={onBgMouseDown} style={{cursor: bgPan ? "grabbing" : "grab", pointerEvents:"none"}}/>

      {mapBgUrl && (
        <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
           clipPath="url(#bgClip)">
          <image href={mapBgUrl} x={bgX} y={bgY} width={bgW} height={bgH}
                 opacity={mapBgOpacity ?? 0.3}
                 preserveAspectRatio="xMidYMid meet"
                 style={{pointerEvents:"none"}}/>
        </g>
      )}

      <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
      {rackLinks.map(l => {
        const ra = rackById(l.from), rb = rackById(l.to);
        if (!ra || !rb) return null;
        const pa = getRackCenter(ra), pb = getRackCenter(rb);
        const c = l.speed === "100G" ? "#22d3ee" : l.speed === "10G" ? "#4ade80" : "#334155";
        const w = l.speed === "100G" ? 2.5 : 1.5;
        return (
          <g key={l.key}>
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                  stroke={c} strokeWidth={w} strokeOpacity={0.45}/>
            <text x={(pa.x+pb.x)/2} y={(pa.y+pb.y)/2 - 6}
                  fill={c} fontSize={9} textAnchor="middle"
                  opacity={0.75} fontFamily="monospace">{l.speed}</text>
          </g>
        );
      })}

      {racks.map(rack => {
        const pos  = getRackCenter(rack);
        const sel  = selectedRackId === rack.id;
        const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
        const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
        const RW = 110, RH = 88;
        const classMap = switchClasses ? Object.fromEntries((switchClasses || []).map(c => [c.id, c])) : {};
        const classIds = [...new Set(rack.devices.map(d => d.class_id).filter(Boolean))];
        const classColors = classIds.map(id => classMap[id]?.color).filter(Boolean);
        return (
          <g key={rack.id}
             transform={`translate(${pos.x},${pos.y})`}
             onMouseDown={e => onMouseDown(e, rack)}
             onMouseUp={e => onMouseUp(e, rack)}
             style={{ cursor: drag?.rackId === rack.id ? "grabbing" : "grab" }}
             filter={sel ? "url(#glow)" : undefined}
          >
            <rect x={-RW/2-8} y={-RH/2-8} width={RW+16} height={RH+16} rx={12}
                  fill="none"
                  stroke={sel ? "#22d3ee" : "#1e293b"}
                  strokeWidth={sel ? 2 : 1}
                  strokeDasharray={sel ? "none" : "6 3"}
                  opacity={sel ? 1 : 0.5}/>
            <rect x={-RW/2} y={-RH/2} width={RW} height={RH} rx={8}
                  fill={sel ? "#0a1e36" : "#080d18"}
                  stroke={sel ? "#22d3ee" : "#1e293b"}
                  strokeWidth={1.5}/>
            {classColors.length > 0 && classColors.map((c, i) => (
              <rect key={i}
                x={-RW/2 + 4 + i * (Math.min(20, (RW - 8) / classColors.length))}
                y={-RH/2 + 3}
                width={Math.min(18, (RW - 8) / classColors.length - 2)}
                height={4}
                rx={2}
                fill={c}
                opacity={0.85}/>
            ))}
            <text textAnchor="middle" dominantBaseline="central" y={-6}
                  fill={sel ? "#22d3ee" : "#e2e8f0"}
                  fontSize={12} fontFamily="monospace" fontWeight="bold">
              {rack.label}
            </text>
            {totalPorts > 0 && (
              <text textAnchor="middle" dominantBaseline="central" y={12} fill="#475569" fontSize={8} fontFamily="monospace">
                {activePorts}/{totalPorts} ports active
              </text>
            )}
          </g>
        );
      })}

      {racks.length === 0 && (
        <text x={W/2} y={H/2} textAnchor="middle" fill="#1e293b"
              fontSize={13} fontFamily="monospace">
          No switches found - add credentials and run scan
        </text>
      )}
      </g>
    </svg>
  );
}


// ── RackDetail ───────────────────────────────────────────────────────────────
function RackDetail({ rack, allRacks, switchClasses, topologyLinks, deviceOrder, onReorder, onClose, onRename, onMoveDevice, onUpdateDeviceMeta }) {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(rack.label);
  const [selectedLink, setSelectedLink] = useState(null);
  const totalPorts  = rack.devices.reduce((s,d) => s + d.ports.length, 0);
  const activePorts = rack.devices.reduce((s,d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
  const otherRacks  = (allRacks || []).filter(r => r.id !== rack.id);

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

  const torDevices    = useMemo(() => sortGroup(rack.devices.filter(d => d.vendor === "fs"),       "fs"),       [rack.devices, sortGroup]);
  const accessDevices = useMemo(() => sortGroup(rack.devices.filter(d => d.vendor === "aruba_cx"), "aruba_cx"), [rack.devices, sortGroup]);
  const otherDevices  = useMemo(() => rack.devices.filter(d => d.vendor !== "fs" && d.vendor !== "aruba_cx"), [rack.devices]);

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
      const key = [l.local_ip, l.remote_ip].sort().join("|");
      if (localHere && remoteHere) {
        if (!seenIntra.has(key)) { seenIntra.add(key); intraAll.push(l); }
      } else if (localHere || remoteHere) {
        if (!seenExternal.has(key)) {
          seenExternal.add(key);
          const norm = localHere ? l : { ...l,
            local_ip: l.remote_ip, local_port: l.remote_port,
            remote_ip: l.local_ip, remote_port: l.local_port };
          external.push({ ...norm, remoteRack: ipToRack[norm.remote_ip] });
        }
      }
    });

    const uplinks = intraAll.filter(l => {
      const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
      return (a?.vendor === "aruba_cx" && b?.vendor === "fs") ||
             (a?.vendor === "fs" && b?.vendor === "aruba_cx");
    });
    const trunks = intraAll.filter(l => {
      const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
      return a?.vendor === "fs" && b?.vendor === "fs";
    });
    return { uplinks, trunks, external };
  }, [rack.devices, topologyLinks, allRacks]);

  const devByIp = useMemo(() => Object.fromEntries(rack.devices.map(d => [d.ip, d])), [rack.devices]);

  const allIntraLinks = useMemo(() => [...uplinks, ...trunks], [uplinks, trunks]);
  const portLinkMap   = useMemo(() => buildPortLinkMap(allIntraLinks), [allIntraLinks]);
  const linkColorMap  = useMemo(() => {
    const m = {};
    allIntraLinks.forEach((l, i) => {
      const c = CABLE_COLORS[i % CABLE_COLORS.length];
      m[`${l.local_ip}:${l.local_port}`]   = c;
      m[`${l.remote_ip}:${l.remote_port}`] = c;
    });
    return m;
  }, [allIntraLinks]);
  const selColor  = selectedLink ? (linkColorMap[`${selectedLink.local_ip}:${selectedLink.local_port}`] || "#22d3ee") : null;
  const toggleLink = useCallback((l) =>
    setSelectedLink(p => p?.local_ip===l?.local_ip && p?.local_port===l?.local_port ? null : l),
  []);

  const [linkLine, setLinkLine] = useState(null);
  const scrollRef = useRef(null);
  const panelHeaderRef = useRef(null);

  useEffect(() => {
    if (!selectedLink) { setLinkLine(null); return; }
    const computeLine = () => {
      const fromKey = `${selectedLink.local_ip}:${selectedLink.local_port}`;
      const toKey   = `${selectedLink.remote_ip}:${selectedLink.remote_port}`;
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
  }, [selectedLink]);

  const classMap = useMemo(() => Object.fromEntries((switchClasses || []).map(c => [c.id, c])), [switchClasses]);

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
            fontSize:9, lineHeight:1, padding:0, display:"flex",
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
            fontSize:9, lineHeight:1, padding:0, display:"flex",
            alignItems:"center", justifyContent:"center",
          }}>v</button>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <SwitchPanel device={d} otherRacks={otherRacks} onMove={onMoveDevice}
          onUpdateMeta={onUpdateDeviceMeta}
          portLinkMap={portLinkMap} selectedLink={selectedLink}
          onPortClick={toggleLink} linkColorMap={linkColorMap}
          switchClass={d.class_id ? classMap[d.class_id] : null}/>
      </div>
    </div>
  ));

  const renderLink = (l, i, accentColor) => {
    const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
    const isSel = selectedLink?.local_ip===l.local_ip && selectedLink?.local_port===l.local_port
               || selectedLink?.remote_ip===l.local_ip && selectedLink?.remote_port===l.local_port;
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
          <div style={{color:"#334155",fontSize:9,marginTop:1}}>{l.local_port}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <div style={{
            width:"100%", height: isSel ? 5 : 4, borderRadius:2,
            background:`linear-gradient(90deg, ${accentColor}cc, ${accentColor})`,
            boxShadow: isSel ? `0 0 10px ${accentColor}` : `0 0 6px ${accentColor}88`,
          }}/>
          <span style={{
            fontSize:8, color:accentColor, fontWeight:700,
            letterSpacing:"0.05em",
          }}>{l.speed_label}</span>
        </div>
        <div style={{minWidth:0,paddingLeft:6,textAlign:"right"}}>
          <div style={{
            color: isSel ? accentColor : (VENDOR_COLOR[b?.vendor]||"#94a3b8"),
            fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{b?.sys_name || l.remote_ip} {VENDOR_ICON[b?.vendor]||"[--]"}</div>
          <div style={{color:"#334155",fontSize:9,marginTop:1}}>{l.remote_port}</div>
        </div>
      </div>
    );
  };

  return (
    <>
    <div style={{
      position:"fixed", right:0, top:48, bottom:0, width:760,
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
              fontSize:10, color:"#22d3ee", marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:"1px solid #164e63",height:0,display:"inline-block"}}/>
              [FS] Top-of-Rack ({torDevices.length})
              <span style={{flex:1,borderBottom:"1px solid #164e63",height:0,display:"inline-block"}}/>
            </div>
            {renderGroup(torDevices, "fs")}
          </>
        )}

        {accessDevices.length > 0 && (
          <>
            <div style={{
              fontSize:10, color:"#f59e0b", marginTop:10, marginBottom:6,
              letterSpacing:"0.1em", textTransform:"uppercase",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{flex:1,borderBottom:"1px solid #78350f",height:0,display:"inline-block"}}/>
              Access ({accessDevices.length})
              <span style={{flex:1,borderBottom:"1px solid #78350f",height:0,display:"inline-block"}}/>
            </div>
            {renderGroup(accessDevices, "aruba_cx")}
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
              {uplinks.map((l, i) => renderLink(l, i, CABLE_COLORS[i % CABLE_COLORS.length]))}
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
              {trunks.map((l, i) => renderLink(l, i, "#22d3ee"))}
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
                      <div style={{color:"#334155",fontSize:9,marginTop:1}}>{l.local_port}</div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                      <div style={{width:"100%",height:3,borderRadius:2,background:`linear-gradient(90deg,${c}99,${c})`,boxShadow:`0 0 5px ${c}66`}}/>
                      <span style={{fontSize:8,color:c,fontWeight:700,letterSpacing:"0.05em"}}>{l.speed_label}</span>
                    </div>
                    <div style={{minWidth:0,paddingLeft:6,textAlign:"right"}}>
                      <div style={{color:"#818cf8",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {remoteLabel}
                      </div>
                      <div style={{color:"#334155",fontSize:9,marginTop:1}}>{l.remote_port}</div>
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
              const c = CABLE_COLORS[i % CABLE_COLORS.length];
              const isSel = selectedLink?.local_ip===l.local_ip && selectedLink?.local_port===l.local_port;
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
                    padding:"1px 5px", fontSize:9,
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


// ── MapPage ──────────────────────────────────────────────────────────────────
export default function MapPage() {
  const [topology, setTopology]     = useState({ nodes:[], links:[], racks:[], classes:[] });
  const [selectedRack, setSelectedRack] = useState(null);
  const [filters, setFilters]     = useState({ racks: null, classes: null });
  const [mapBgUrl, setMapBgUrl]   = useState(null);
  const [mapBgNat, setMapBgNat]   = useState(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);
  const initializedRef = useRef(false);

  const loadTopology = useCallback(() => {
    api.get("/api/topology").then(data => {
      setTopology(data);
      if (selectedRack) {
        const freshDevices = data.nodes.filter(n => n.rack_id === selectedRack.id);
        if (freshDevices.length > 0)
          setSelectedRack(prev => ({ ...prev, devices: freshDevices }));
      }
    }).catch(console.error);
  }, [selectedRack]);

  useEffect(() => {
    api.get("/api/topology").then(data => {
      setTopology(data);
      const savedId = sessionStorage.getItem("selectedRackId");
      if (savedId) {
        const id = Number(savedId);
        const rack = (data.racks || []).find(r => r.id === id);
        if (rack) {
          const devices = data.nodes.filter(n => n.rack_id === id);
          setSelectedRack({ id: rack.id, label: rack.label, location: rack.location || `${rack.label}${rack.room ? " / " + rack.room : ""}`, devices });
        } else {
          sessionStorage.removeItem("selectedRackId");
        }
      }
      initializedRef.current = true;
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    if (selectedRack) sessionStorage.setItem("selectedRackId", String(selectedRack.id));
    else sessionStorage.removeItem("selectedRackId");
  }, [selectedRack]);

  // Map background
  const loadMapBg = useCallback(() => {
    fetch(`${API}/api/map-background`, { method: "GET" })
      .then(r => {
        if (r.ok) {
          const url = `${API}/api/map-background?v=${Date.now()}`;
          setMapBgUrl(url);
          const img = new Image();
          img.onload = () => setMapBgNat({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => setMapBgNat(null);
          img.src = url;
        } else {
          setMapBgUrl(null);
          setMapBgNat(null);
        }
      })
      .catch(() => { setMapBgUrl(null); setMapBgNat(null); });
  }, []);
  useEffect(() => { loadMapBg(); }, []);

  const loadMapSettings = useCallback(() => {
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
    }).catch(console.error);
  }, []);
  useEffect(() => { loadMapSettings(); }, []);

  const savePosition = (id, x, y) => {
    api.patch(`/api/topology/devices/${id}/position`, { map_x: x, map_y: y }).catch(console.error);
  };

  const allRacks = useMemo(() => {
    const rackMap = {};
    (topology.racks || []).forEach(r => {
      rackMap[r.id] = { id: r.id, label: r.label, room: r.room, description: r.description, devices: [] };
    });
    const unassigned = { id: "__unassigned__", label: "Unassigned", room: "", description: "", devices: [] };
    topology.nodes.forEach(n => {
      if (n.rack_id && rackMap[n.rack_id]) {
        rackMap[n.rack_id].devices.push(n);
      } else {
        unassigned.devices.push(n);
      }
    });
    const result = Object.values(rackMap);
    if (unassigned.devices.length > 0) result.push(unassigned);
    return result;
  }, [topology.nodes, topology.racks]);

  const renameRack = async (rack, newName) => {
    if (rack.id === "__unassigned__") return;
    await api.put(`/api/racks/${rack.id}`, { label: newName });
    setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
    loadTopology();
  };

  const moveDevice = async (device, newRackId) => {
    const rId = newRackId === "__unassigned__" ? null : newRackId;
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: rId });
    setSelectedRack(prev => prev ? { ...prev, devices: prev.devices.filter(d => d.id !== device.id) } : null);
    loadTopology();
  };

  const updateDeviceMeta = async (device, patch) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, patch);
    loadTopology();
  };

  // Rack ordering
  const [rackOrders, setRackOrders] = useState(() => {
    try { return JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"); }
    catch { return {}; }
  });

  const reorderDevice = (deviceId, direction, groupKey) => {
    if (!selectedRack) return;
    const rackId  = selectedRack.id;
    const devs    = selectedRack.devices.filter(d =>
      groupKey === "fs"       ? d.vendor === "fs" :
      groupKey === "aruba_cx" ? d.vendor === "aruba_cx" :
      d.vendor !== "fs" && d.vendor !== "aruba_cx"
    );
    const ids    = devs.map(d => d.id);
    const storeKey = `${rackId}::${groupKey}`;
    const order  = (rackOrders[storeKey]) || [];
    const sorted = [...ids].sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const idx    = sorted.indexOf(deviceId);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    [sorted[idx], sorted[newIdx]] = [sorted[newIdx], sorted[idx]];
    const newOrders = { ...rackOrders, [storeKey]: sorted };
    setRackOrders(newOrders);
    localStorage.setItem("netmap_rack_orders", JSON.stringify(newOrders));
  };

  const panelOpen = !!selectedRack;

  const links10g = topology.links.filter(l => ["10G","25G","40G","100G"].includes(l.speed_label)).length;
  const links1g  = topology.links.filter(l => l.speed_label === "1G").length;

  return (
    <>
      {/* Map toolbar */}
      <div style={{
        padding: "8px 24px", borderBottom: "1px solid #0f172a",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        backgroundColor: "#020817", fontSize: 11,
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: "#475569" }}><span style={{ color: "#22c55e" }}>|</span> {topology.nodes.length} Switches</span>
          <span style={{ color: "#475569" }}><span style={{ color: "#22d3ee" }}>|</span> {links10g} x {">="}10G</span>
          <span style={{ color: "#475569" }}><span style={{ color: "#334155" }}>|</span> {links1g} x 1G</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={loadTopology}
            title="Reload topology"
            style={{
              border: "1px solid #1e293b", background: "none",
              color: "#475569", borderRadius: 6, padding: "4px 10px",
              cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11,
            }}
          >(R)</button>
        </div>
      </div>

      <div style={{ padding: 24, marginRight: panelOpen ? 760 : 0, transition: "margin-right 0.25s ease" }}>
        <FilterBar
          racks={topology.racks || []}
          classes={topology.classes || []}
          filters={filters}
          onFilterChange={setFilters}
        />
        <div style={{ border: "1px solid #0f172a", borderRadius: 12, overflow: "hidden" }}>
          <TopologyMap
            nodes={topology.nodes}
            links={topology.links}
            managedRacks={topology.racks || []}
            switchClasses={topology.classes || []}
            filters={filters}
            onSelectRack={rack => { setSelectedRack(p => p?.id === rack.id ? null : rack); }}
            selectedRackId={selectedRack?.id}
            onPositionChange={savePosition}
            mapBgUrl={mapBgUrl}
            mapBgOpacity={mapBgOpacity}
            mapBgScale={mapBgScale}
            mapBgNat={mapBgNat}
          />
        </div>
        {topology.nodes.length === 0 && (
          <p style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 12 }}>
            No switches found - add credentials in Settings and run Scan
          </p>
        )}
      </div>

      {selectedRack && (
        <RackDetail
          rack={selectedRack}
          allRacks={allRacks}
          switchClasses={topology.classes || []}
          topologyLinks={topology.links}
          deviceOrder={selectedRack ? Object.fromEntries(
            ["fs","aruba_cx","other"].map(g => [
              g, rackOrders[`${selectedRack.id}::${g}`]
            ])
          ) : {}}
          onReorder={(deviceId, dir) => reorderDevice(deviceId, dir)}
          onClose={() => setSelectedRack(null)}
          onRename={newName => renameRack(selectedRack, newName)}
          onMoveDevice={moveDevice}
          onUpdateDeviceMeta={updateDeviceMeta}
        />
      )}
    </>
  );
}
