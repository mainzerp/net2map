import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ── TopologyMap (SVG) ─────────────────────────────────────────────────────────
function _isValidZoom(z) {
  return (
    z !== null && typeof z === "object" &&
    typeof z.scale === "number" && isFinite(z.scale) &&
    typeof z.tx === "number" && isFinite(z.tx) &&
    typeof z.ty === "number" && isFinite(z.ty)
  );
}

function TopologyMap({ nodes, links, managedRacks, switchClasses, filters, onSelectRack, selectedRackId, onPositionChange, mapBgUrl, mapBgOpacity, mapBgScale, mapBgNat }) {
  const W = 900, H = 550;
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [positions, setPositions] = useState({});
  const [zoom, setZoom] = useState(() => {
    try {
      const s = localStorage.getItem("netmap-zoom");
      if (s) {
        const parsed = JSON.parse(s);
        if (_isValidZoom(parsed)) return parsed;
      }
    } catch {}
    return { scale: 1, tx: 0, ty: 0 };
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
    const grouped = {};
    links.forEach(l => {
      const ra = ipToRackId[l.local_ip];
      const rb = ipToRackId[l.remote_ip];
      if (!ra || !rb || ra === rb) return;
      const key = [ra, rb].sort().join("|");
      if (!grouped[key]) grouped[key] = { key, from: ra, to: rb, individual: [] };
      grouped[key].individual.push(l);
    });
    return Object.values(grouped).map(g => {
      // Deduplicate by sorted port-pair key to avoid counting both directions
      const portSeen = new Set();
      const unique = [];
      g.individual.forEach(l => {
        const pk = [l.local_ip + ":" + l.local_port, l.remote_ip + ":" + l.remote_port].sort().join("|");
        if (!portSeen.has(pk)) { portSeen.add(pk); unique.push(l); }
      });
      // Pick the highest speed for the line color
      const speedOrder = { "100G":5, "25G":4, "10G":3, "1G":2, "100M":1 };
      const best = unique.reduce((a, b) => (speedOrder[b.speed_label] || 0) > (speedOrder[a.speed_label] || 0) ? b : a, unique[0]);
      return { ...g, count: unique.length, speed: best.speed_label };
    });
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
        const c = l.speed === "100G" ? "#22d3ee" : l.speed === "10G" || l.speed === "25G" ? "#4ade80" : "#334155";
        const w = l.speed === "100G" ? 2.5 : 1.5;
        const label = l.count > 1 ? `${l.count}x ${l.speed}` : l.speed;
        return (
          <g key={l.key}>
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                  stroke={c} strokeWidth={w * Math.min(l.count, 4)} strokeOpacity={0.45}/>
            <text x={(pa.x+pb.x)/2} y={(pa.y+pb.y)/2 - 6}
                  fill={c} fontSize={9} textAnchor="middle"
                  opacity={0.75} fontFamily="monospace">{label}</text>
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

export default TopologyMap;
