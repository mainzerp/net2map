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

function TopologyMap({ nodes, links, managedRacks, switchClasses, filters, onSelectRack, onSelectOutside, selectedRackId, selectedOutsideId, centerRackId, onPositionChange, mapBgUrl, mapBgOpacity, mapBgScale, mapBgNat, mapBgColor, rackPairColorMap, selectedLink }) {
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
    try { localStorage.setItem("netmap-zoom", JSON.stringify(zoom)); } catch {}
  }, [zoom]);

  useEffect(() => {
    const pos = {};
    nodes.forEach(n => { pos[n.id] = { x: n.map_x, y: n.map_y }; });
    setPositions(pos);
  }, [nodes]);

  // Pan map to center the selected rack when centerRackId changes
  useEffect(() => {
    if (!centerRackId) return;
    const rackDevices = nodes.filter(n => n.rack_id === centerRackId);
    if (!rackDevices.length) return;
    const xs = rackDevices.map(n => positions[n.id]?.x ?? n.map_x);
    const ys = rackDevices.map(n => positions[n.id]?.y ?? n.map_y);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    setZoom(z => ({
      ...z,
      tx: W / 2 - cx * z.scale,
      ty: H / 2 - cy * z.scale,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerRackId]);

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
    nodes.forEach(node => {
      if (node.rack_id && map[node.rack_id]) {
        map[node.rack_id].devices.push(node);
      }
      // nodes without a rack assignment are not shown on the map
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

  const classMap = useMemo(
    () => Object.fromEntries((switchClasses || []).map(c => [c.id, c])),
    [switchClasses],
  );
  const classAllowsOutside = useMemo(
    () => Object.fromEntries((switchClasses || []).map(c => [c.id, !!c.allow_outside_rack])),
    [switchClasses],
  );

  const outsideNodes = useMemo(() => {
    let result = nodes.filter(node => node.rack_id == null && node.class_id && classAllowsOutside[node.class_id]);
    if (filters?.classes) {
      result = result.filter(node => node.class_id && filters.classes.has(node.class_id));
    }
    return result;
  }, [nodes, filters, classAllowsOutside]);

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

  const endpointByIp = useMemo(() => {
    const rackForNode = {};
    (managedRacks || []).forEach(r => { rackForNode[String(r.id)] = true; });
    const map = {};
    nodes.forEach(node => {
      const rackKey = node.rack_id != null ? String(node.rack_id) : null;
      if (rackKey && rackForNode[rackKey]) {
        map[node.ip] = rackKey;
      } else if (node.class_id && classAllowsOutside[node.class_id]) {
        map[node.ip] = `outside:${node.id}`;
      }
    });
    return map;
  }, [nodes, managedRacks, classAllowsOutside]);

  const visibleEndpointIds = useMemo(() => {
    const visible = new Set(racks.map(r => String(r.id)));
    outsideNodes.forEach(node => {
      visible.add(`outside:${node.id}`);
    });
    return visible;
  }, [racks, outsideNodes]);

  const endpointLinks = useMemo(() => {
    const grouped = {};
    links.forEach(l => {
      const endpointA = endpointByIp[l.local_ip];
      const endpointB = endpointByIp[l.remote_ip];
      if (!endpointA || !endpointB || endpointA === endpointB) return;
      if (!visibleEndpointIds.has(endpointA) || !visibleEndpointIds.has(endpointB)) return;
      const key = [endpointA, endpointB].sort().join("|");
      if (!grouped[key]) grouped[key] = { key, from: endpointA, to: endpointB, individual: [] };
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
  }, [links, endpointByIp, visibleEndpointIds]);

  // Find which endpoint-pair the selected link belongs to
  const activePairKey = useMemo(() => {
    if (!selectedLink) return null;
    const endpointA = endpointByIp[selectedLink.local_ip];
    const endpointB = endpointByIp[selectedLink.remote_ip];
    if (!endpointA || !endpointB || endpointA === endpointB) return null;
    return [endpointA, endpointB].sort().join("|");
  }, [selectedLink, endpointByIp]);

  const svgPoint = (e) => {
    const svg = svgRef.current;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const toContent = (vp) => ({ x: (vp.x - zoom.tx) / zoom.scale, y: (vp.y - zoom.ty) / zoom.scale });

  const onRackMouseDown = (e, rack) => {
    e.stopPropagation();
    const p = toContent(svgPoint(e));
    const center = getRackCenter(rack);
    setDrag({ kind: "rack", rackId: rack.id, rack, devices: rack.devices, ox: p.x - center.x, oy: p.y - center.y, moved: false });
  };

  const onOutsideMouseDown = (e, node) => {
    e.stopPropagation();
    const p = toContent(svgPoint(e));
    const current = positions[node.id] || { x: node.map_x, y: node.map_y };
    setDrag({ kind: "outside", nodeId: node.id, ox: p.x - current.x, oy: p.y - current.y, moved: false });
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
    if (drag.kind === "rack") {
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
    }
    if (drag.kind === "outside") {
      const newX = p.x - drag.ox;
      const newY = p.y - drag.oy;
      setPositions(prev => ({ ...prev, [drag.nodeId]: { x: newX, y: newY } }));
    }
    setDrag(prev => ({ ...prev, moved: true }));
  };

  const onMouseUp = () => {
    if (bgPan) { setBgPan(null); return; }
    if (!drag) return;
    if (drag.kind === "rack") {
      if (!drag.moved) {
        onSelectRack(drag.rack);
      } else {
        drag.devices.forEach(d => {
          const pos = positions[d.id];
          if (pos) onPositionChange(d.id, pos.x, pos.y);
        });
      }
    }
    if (drag.kind === "outside") {
      if (drag.moved) {
        const pos = positions[drag.nodeId];
        if (pos) onPositionChange(drag.nodeId, pos.x, pos.y);
      } else {
        const node = outsideNodes.find(n => n.id === drag.nodeId);
        if (node) onSelectOutside?.(node);
      }
    }
    setDrag(null);
  };

  const rackById = useMemo(
    () => Object.fromEntries(racks.map(r => [String(r.id), r])),
    [racks],
  );
  const outsideByEndpointId = useMemo(
    () => Object.fromEntries(outsideNodes.map(node => [`outside:${node.id}`, node])),
    [outsideNodes],
  );

  const getEndpointCenter = useCallback((endpointId) => {
    if (endpointId.startsWith("outside:")) {
      const node = outsideByEndpointId[endpointId];
      if (!node) return null;
      const pos = positions[node.id] || { x: node.map_x, y: node.map_y };
      return { x: pos.x, y: pos.y };
    }
    const rack = rackById[endpointId];
    if (!rack) return null;
    return getRackCenter(rack);
  }, [outsideByEndpointId, positions, rackById, getRackCenter]);

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
      height="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display:"block", cursor: drag ? "grabbing" : bgPan ? "grabbing" : "default" }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { setDrag(null); setBgPan(null); }}
    >
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke={mapBgColor && mapBgColor !== "#020817" ? "rgba(0,0,0,0.08)" : "#0f172a"} strokeWidth="1"/>
        </pattern>
        {mapBgUrl && (
          <clipPath id="bgClip">
            <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h} rx={18} ry={18}/>
          </clipPath>
        )}
      </defs>
      {/* Layer 1: grid (only when no background image) */}
      {!mapBgUrl && (
        <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" opacity={0.4}
              onMouseDown={onBgMouseDown} style={{cursor: bgPan ? "grabbing" : "grab", pointerEvents:"none"}}/>
      )}
      {/* Invisible panning target when image is present */}
      {mapBgUrl && (
        <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
           clipPath="url(#bgClip)">
          <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h} fill="transparent"
          onMouseDown={onBgMouseDown} style={{cursor: bgPan ? "grabbing" : "grab", pointerEvents: "all"}}/>
        </g>
      )}

      {/* Layer 2: background image + opacity overlay */}
      {mapBgUrl && (
        <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}
           clipPath="url(#bgClip)">
          <image href={mapBgUrl} x={bgX} y={bgY} width={bgW} height={bgH}
                 preserveAspectRatio="xMidYMid meet"
                 style={{pointerEvents:"none"}}/>
          <rect x={bgFit.x} y={bgFit.y} width={bgFit.w} height={bgFit.h}
                fill={mapBgColor || "#020817"}
                opacity={1 - (mapBgOpacity ?? 0.3)}
                style={{pointerEvents:"none"}}/>
        </g>
      )}

      <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
      {endpointLinks.map(l => {
        const pa = getEndpointCenter(l.from);
        const pb = getEndpointCenter(l.to);
        if (!pa || !pb) return null;
        // Use rack-pair color from MapPage if available, otherwise fall back to speed color
        const pairKey = [String(l.from), String(l.to)].sort().join("|");
        const pairColor = rackPairColorMap?.[pairKey];
        const speedFallback = l.speed === "100G" ? "#22d3ee" : l.speed === "10G" || l.speed === "25G" ? "#4ade80" : "#334155";
        const c = pairColor || speedFallback;
        const w = l.speed === "100G" ? 2.5 : 1.5;
        const label = l.count > 1 ? `${l.count}x ${l.speed}` : l.speed;
        const isActive = activePairKey === pairKey;
        return (
          <g key={l.key}>
            {isActive && (
              <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                    stroke={c} strokeWidth={(w * Math.min(l.count, 4)) + 8} strokeOpacity={0.18}/>
            )}
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                  stroke={c} strokeWidth={isActive ? w * Math.min(l.count, 4) + 2 : w * Math.min(l.count, 4)}
                  strokeOpacity={isActive ? 0.9 : 0.55}/>
            <text x={(pa.x+pb.x)/2} y={(pa.y+pb.y)/2 - 6}
                  fill={c} fontSize={9} textAnchor="middle"
                  opacity={isActive ? 1 : 0.85} fontFamily="monospace">{label}</text>
          </g>
        );
      })}

      {racks.map(rack => {
        const pos  = getRackCenter(rack);
        const sel  = selectedRackId === rack.id;
        const totalPorts  = rack.devices.reduce((s,d) => s + (d.ports || []).length, 0);
        const activePorts = rack.devices.reduce((s,d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
        const RW = 110, RH = 88;
        const classIds = [...new Set(rack.devices.map(d => d.class_id).filter(Boolean))];
        const classColors = classIds.map(id => classMap[id]?.color).filter(Boolean);
        return (
          <g key={rack.id}
             transform={`translate(${pos.x},${pos.y})`}
             onMouseDown={e => onRackMouseDown(e, rack)}
             style={{ cursor: drag?.kind === "rack" && drag?.rackId === rack.id ? "grabbing" : "grab" }}
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

      {outsideNodes.map(node => {
        const pos = positions[node.id] || { x: node.map_x, y: node.map_y };
        const classColor = node.class_id ? (classMap[node.class_id]?.color || "#22d3ee") : "#22d3ee";
        const label = node.sys_name || node.ip;
        const isOutsideSelected = selectedOutsideId === node.id;
        return (
          <g
            key={`outside:${node.id}`}
            transform={`translate(${pos.x},${pos.y})`}
            onMouseDown={e => onOutsideMouseDown(e, node)}
            style={{ cursor: drag?.kind === "outside" && drag?.nodeId === node.id ? "grabbing" : "grab" }}
            filter={isOutsideSelected ? "url(#glow)" : undefined}
          >
            <circle r={20} fill={isOutsideSelected ? "#0a1e36" : "#0a0e18"} stroke={isOutsideSelected ? "#22d3ee" : classColor} strokeWidth={isOutsideSelected ? 2.5 : 1.5} />
            <circle r={4} cy={-10} fill={classColor} opacity={0.9} />
            <text textAnchor="middle" dominantBaseline="central" y={2} fill="#e2e8f0" fontSize={10} fontFamily="monospace" fontWeight="bold">
              {label.length > 16 ? `${label.slice(0, 16)}…` : label}
            </text>
            <text textAnchor="middle" dominantBaseline="central" y={13} fill="#475569" fontSize={8} fontFamily="monospace">
              {node.ip}
            </text>
          </g>
        );
      })}

      {racks.length === 0 && outsideNodes.length === 0 && (
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
