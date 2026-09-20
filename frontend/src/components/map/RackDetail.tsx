import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON, buildPortLinkMap, normPort } from "../../api";
import type { TopologyNode, TopologyLink, RackInfo, SwitchClass, SwitchModel } from "../../types";
import SwitchPanel from "../SwitchPanel";

interface RackDetailRack {
  id: number | string;
  label: string;
  location: string;
  devices: TopologyNode[];
}

interface AllRackEntry {
  id: number;
  label: string;
  location?: string;
  room?: string;
  description?: string;
  devices?: TopologyNode[];
}

interface RackDetailProps {
  rack: RackDetailRack;
  allRacks?: AllRackEntry[];
  switchClasses?: SwitchClass[];
  switchModels?: SwitchModel[];
  topologyLinks?: TopologyLink[];
  deviceOrder?: Record<string, string[]>;
  onReorder?: (deviceId: number, direction: "up" | "down", groupKey: string) => void;
  onReorderClass?: (sectionKey: string, direction: "up" | "down", sectionKeys: string[]) => void;
  onClose?: () => void;
  onRename?: (newName: string) => void;
  onMoveDevice?: (device: TopologyNode, rackId: number) => void;
  onUpdateDeviceMeta?: (device: TopologyNode, patch: Record<string, unknown>) => void;
  rackPairColorMap?: Record<string, string>;
  selectedLink?: TopologyLink | null;
  onLinkSelect?: (link: TopologyLink | null) => void;
  onShowDetail?: (deviceId: number) => void;
  highlightPortKey?: string | null;
}

interface LinkLineState {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  clipTop: number;
}

interface ClassSection {
  key: string;
  classId: number | null;
  label: string;
  color: string;
  devices: TopologyNode[];
}

interface ExternalLink extends TopologyLink {
  remoteRack?: AllRackEntry;
}

// ── RackDetail ───────────────────────────────────────────────────────────────
function RackDetail({ rack, allRacks, switchClasses, switchModels, topologyLinks, deviceOrder, onReorder, onReorderClass, onClose, onRename, onMoveDevice, onUpdateDeviceMeta, rackPairColorMap, selectedLink, onLinkSelect, onShowDetail, highlightPortKey }: RackDetailProps) {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(rack.label);
  const canRename = typeof onRename === "function";
  const [localOrder, setLocalOrder] = useState<Record<string, string[]>>({});
  const [localSectionOrder, setLocalSectionOrder] = useState<string[]>([]);
  const [localSelectedLink, setLocalSelectedLink] = useState<TopologyLink | null>(null);
  const resolvedSelectedLink = selectedLink !== undefined ? selectedLink : localSelectedLink;
  const setSelectedLink = onLinkSelect || setLocalSelectedLink;
  const totalPorts  = rack.devices.reduce((s, d) => s + (d.ports || []).length, 0);
  const activePorts = rack.devices.reduce((s, d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
  const otherRacks  = (allRacks || []).filter(r => r.id !== rack.id);

  const commitRename = () => {
    if (!canRename) {
      setEditing(false);
      return;
    }
    if (nameInput.trim() && nameInput.trim() !== rack.label) onRename?.(nameInput.trim());
    setEditing(false);
  };

  useEffect(() => {
    setLocalOrder({});
    setLocalSectionOrder([]);
  }, [rack.id]);

  const applyLocalReorder = useCallback((deviceId: number, direction: "up" | "down", groupKey: string, devices: TopologyNode[]) => {
    const ids = devices.map(d => String(d.id));
    if (!ids.length) return;
    const current = ((localOrder[groupKey] || []).map(id => String(id)));
    const base = current.length ? current : ids;
    const merged = [
      ...base.filter(id => ids.includes(id)),
      ...ids.filter(id => !base.includes(id)),
    ];
    const idx = merged.indexOf(String(deviceId));
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= merged.length) return;
    [merged[idx], merged[newIdx]] = [merged[newIdx], merged[idx]];
    setLocalOrder(prev => ({ ...prev, [groupKey]: merged }));
  }, [localOrder]);

  const applyLocalSectionReorder = useCallback((sectionKey: string, direction: "up" | "down", sectionKeys: string[]) => {
    const keys = Array.isArray(sectionKeys) ? sectionKeys.map(k => String(k)) : [];
    if (!keys.length) return;
    const base = localSectionOrder.length ? localSectionOrder : keys;
    const merged = [
      ...base.filter(k => keys.includes(k)),
      ...keys.filter(k => !base.includes(k)),
    ];
    const idx = merged.indexOf(String(sectionKey));
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= merged.length) return;
    [merged[idx], merged[newIdx]] = [merged[newIdx], merged[idx]];
    setLocalSectionOrder(merged);
  }, [localSectionOrder]);

  const sortGroup = useCallback((devices: TopologyNode[], groupKey: string) => {
    const order = (((localOrder || {})[groupKey] || (deviceOrder || {})[groupKey] || []).map(id => String(id)));
    if (!order.length) return devices;
    return [...devices].sort((a, b) => {
      const ai = order.indexOf(String(a.id)), bi = order.indexOf(String(b.id));
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [deviceOrder, localOrder]);

  const classMap = useMemo(() => Object.fromEntries((switchClasses || []).map(c => [c.id, c])), [switchClasses]);
  const modelMap = useMemo(() => Object.fromEntries((switchModels || []).map(m => [m.id, m])), [switchModels]);
  const classOrderMap = useMemo(() => {
    const m: Record<number, number> = {};
    (switchClasses || []).forEach((c, idx) => { m[c.id] = idx; });
    return m;
  }, [switchClasses]);

  const classSections = useMemo((): ClassSection[] => {
    const grouped: Record<string, ClassSection> = {};
    const unclassified: TopologyNode[] = [];

    (rack.devices || []).forEach(d => {
      if (d.class_id == null) {
        unclassified.push(d);
        return;
      }
      const key = `class:${d.class_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          key,
          classId: d.class_id,
          label: classMap[d.class_id]?.label || `Class ${d.class_id}`,
          color: classMap[d.class_id]?.color || "#22d3ee",
          devices: [],
        };
      }
      grouped[key].devices.push(d);
    });

    const classGroups = Object.values(grouped)
      .sort((a, b) => {
        const ai = (a.classId != null ? classOrderMap[a.classId] : undefined) ?? (1000 + Number(a.classId || 0));
        const bi = (b.classId != null ? classOrderMap[b.classId] : undefined) ?? (1000 + Number(b.classId || 0));
        return ai - bi;
      })
      .map(g => ({ ...g, devices: sortGroup(g.devices, g.key) }));

    const withUnclassified: ClassSection[] = !unclassified.length ? classGroups : [
      ...classGroups,
      {
        key: "unclassified",
        classId: null,
        label: "Other",
        color: "#64748b",
        devices: sortGroup(unclassified, "unclassified"),
      },
    ];

    const savedOrder = ((deviceOrder || {} as Record<string, string[]>).__class_sections__ || []).map((k: string) => String(k));
    const baseOrder = localSectionOrder.length ? localSectionOrder : savedOrder;
    if (!baseOrder.length) return withUnclassified;

    const sectionMap = Object.fromEntries(withUnclassified.map(s => [String(s.key), s]));
    const ordered: ClassSection[] = [];
    baseOrder.forEach((k: string) => {
      if (sectionMap[k]) ordered.push(sectionMap[k]);
    });
    withUnclassified.forEach(s => {
      if (!ordered.find(x => x.key === s.key)) ordered.push(s);
    });
    return ordered;
  }, [rack.devices, classMap, classOrderMap, sortGroup, deviceOrder, localSectionOrder]);

  const { uplinks, trunks, external } = useMemo(() => {
    const rackIps  = new Set(rack.devices.map(d => d.ip));
    const devByIp  = Object.fromEntries(rack.devices.map(d => [d.ip, d]));
    const ipToRack: Record<string, AllRackEntry> = {};
    (allRacks || []).forEach(r => { (r.devices || []).forEach(d => { ipToRack[d.ip] = r; }); });

    const seenIntra    = new Set<string>();
    const seenExternal = new Set<string>();
    const intraAll: TopologyLink[] = [];
    const external: ExternalLink[] = [];

    (topologyLinks || []).forEach(l => {
      const localHere  = rackIps.has(l.local_ip);
      const remoteHere = rackIps.has(l.remote_ip);
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
  const allVisibleLinks = useMemo(() => [...allIntraLinks, ...external], [allIntraLinks, external]);
  const portLinkMap   = useMemo(() => buildPortLinkMap(allVisibleLinks), [allVisibleLinks]);

  const interRackPortKeys = useMemo(() => {
    const s = new Set<string>();
    external.forEach(l => {
      s.add(`${l.local_ip}:${normPort(l.local_port)}`);
      s.add(`${l.remote_ip}:${normPort(l.remote_port)}`);
    });
    return s;
  }, [external]);

  const ipToRackId = useMemo(() => {
    const m: Record<string, string> = {};
    (allRacks || []).forEach(r => {
      if (r.id) (r.devices || []).forEach(d => { m[d.ip] = String(r.id); });
    });
    return m;
  }, [allRacks]);

  const linkColorMap  = useMemo(() => {
    const m: Record<string, string> = {};
    const pairColors: Record<string, string> = {};
    let colorIdx = 0;
    allVisibleLinks.forEach(l => {
      const pairKey = [l.local_ip, l.remote_ip].sort().join("|");
      if (!(pairKey in pairColors)) {
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
  const toggleLink = useCallback((l: TopologyLink | null) => {
    const p = resolvedSelectedLink;
    // Match the isSel logic below: a link counts as selected in either
    // orientation, so deselect must check both directions too.
    const isSel = !!p && !!l && (
      (p.local_ip === l.local_ip && p.local_port === l.local_port) ||
      (p.remote_ip === l.local_ip && p.remote_port === l.local_port)
    );
    setSelectedLink(isSel ? null : l);
  }, [setSelectedLink, resolvedSelectedLink]);

  const [linkLine, setLinkLine] = useState<LinkLineState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelHeaderRef = useRef<HTMLDivElement>(null);

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

  const renderGroup = (devices: TopologyNode[], groupKey: string) => devices.map((d, idx) => (
    <div key={d.id} style={{display:"flex",alignItems:"flex-start",gap:5,marginBottom:4}}>
      <div style={{display:"flex",flexDirection:"column",gap:2,paddingTop:8,flexShrink:0}}>
        <button
          type="button"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            applyLocalReorder(d.id, "up", groupKey, devices);
            onReorder?.(d.id, "up", groupKey);
          }}
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
          type="button"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            applyLocalReorder(d.id, "down", groupKey, devices);
            onReorder?.(d.id, "down", groupKey);
          }}
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
          switchModel={d.model_id ? modelMap[d.model_id] : null}
          onShowDetail={onShowDetail}
          highlightPortKey={highlightPortKey}/>
      </div>
    </div>
  ));

  const renderLink = (l: TopologyLink, i: number, accentColor: string) => {
    const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
    const isSel = (resolvedSelectedLink?.local_ip===l.local_ip && resolvedSelectedLink?.local_port===l.local_port)
               || (resolvedSelectedLink?.remote_ip===l.local_ip && resolvedSelectedLink?.remote_port===l.local_port);
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
      width:"100%", height:"100%",
      backgroundColor:"#020817", borderLeft:"1px solid #1e293b",
      display:"flex", flexDirection:"column",
      fontFamily:"'Inter', system-ui, sans-serif",
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
          {editing && canRename ? (
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
              {canRename && (
                <button
                  onClick={() => { setNameInput(rack.label); setEditing(true); }}
                  title="Rename rack"
                  style={{background:"none",border:"1px solid #1e293b",color:"#475569",borderRadius:4,padding:"2px 6px",cursor:"pointer",fontSize:11}}
                >Edit</button>
              )}
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
      <div ref={scrollRef} style={{flex:1,overflowY:"auto",overflowX:"auto",padding:"12px 20px"}}>

        {classSections.map((section, idx) => (
          <div key={section.key}>
            <div style={{
              fontSize:10,
              color: section.color,
              marginTop: idx === 0 ? 0 : 10,
              marginBottom:6,
              letterSpacing:"0.1em",
              textTransform:"uppercase",
              display:"flex",
              alignItems:"center",
              gap:8,
            }}>
              <span style={{flex:1,borderBottom:`1px solid ${section.color}44`,height:0,display:"inline-block"}}/>
              {section.label} ({section.devices.length})
              <span style={{flex:1,borderBottom:`1px solid ${section.color}44`,height:0,display:"inline-block"}}/>
              <div style={{display:"flex",gap:2,marginLeft:4}}>
                <button
                  type="button"
                  onPointerDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const sectionKeys = classSections.map(s => String(s.key));
                    applyLocalSectionReorder(section.key, "up", sectionKeys);
                    onReorderClass?.(section.key, "up", sectionKeys);
                  }}
                  disabled={idx === 0}
                  style={{
                    background:"none", border:"1px solid #1e293b",
                    color: idx === 0 ? "#1e293b" : "#475569",
                    borderRadius:3, width:16, height:16,
                    cursor: idx === 0 ? "default" : "pointer",
                    fontSize:9, lineHeight:1, padding:0, display:"flex",
                    alignItems:"center", justifyContent:"center",
                  }}
                >^</button>
                <button
                  type="button"
                  onPointerDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const sectionKeys = classSections.map(s => String(s.key));
                    applyLocalSectionReorder(section.key, "down", sectionKeys);
                    onReorderClass?.(section.key, "down", sectionKeys);
                  }}
                  disabled={idx === classSections.length - 1}
                  style={{
                    background:"none", border:"1px solid #1e293b",
                    color: idx === classSections.length - 1 ? "#1e293b" : "#475569",
                    borderRadius:3, width:16, height:16,
                    cursor: idx === classSections.length - 1 ? "default" : "pointer",
                    fontSize:9, lineHeight:1, padding:0, display:"flex",
                    alignItems:"center", justifyContent:"center",
                  }}
                >v</button>
              </div>
            </div>
            {renderGroup(section.devices, section.key)}
          </div>
        ))}

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
