import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { buildPortLinkMap, normPort } from "../../api";
import { CABLE_COLORS, VENDOR_COLOR, VENDOR_ICON } from "../../theme/visual";
import type { TopologyNode, TopologyLink, SwitchClass, SwitchModel } from "../../types";
import SwitchPanel from "../SwitchPanel";
import { splitDevicesForRackPanel, uBadgeLabel } from "./rackPanelOrder";

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

const reorderBtnClass = (disabled: boolean) =>
  `bg-transparent border border-line rounded w-[18px] h-[18px] text-[10px] leading-none p-0 flex items-center justify-center transition-colors ${
    disabled ? "text-line cursor-default" : "text-muted hover:text-accent hover:border-accent cursor-pointer"
  }`;

const sectionReorderBtnClass = (disabled: boolean) =>
  `bg-transparent border border-line rounded w-4 h-4 text-[9px] leading-none p-0 flex items-center justify-center transition-colors ${
    disabled ? "text-line cursor-default" : "text-muted hover:text-accent hover:border-accent cursor-pointer"
  }`;

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

  const { placed: placedDevices, unplaced: unplacedDevices } = useMemo(
    () => splitDevicesForRackPanel(rack.devices || []),
    [rack.devices],
  );

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

    unplacedDevices.forEach(d => {
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
          color: classMap[d.class_id]?.color || "var(--accent)",
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
        color: "var(--muted)",
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
  }, [unplacedDevices, classMap, classOrderMap, sortGroup, deviceOrder, localSectionOrder]);

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
  const selColor  = resolvedSelectedLink ? (linkColorMap[`${resolvedSelectedLink.local_ip}:${normPort(resolvedSelectedLink.local_port)}`] || "var(--accent)") : null;
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
      // Port names/IPs are user-controlled data -- escape before embedding
      // them in a CSS attribute selector.
      const a = document.querySelector(`[data-pkey="${CSS.escape(fromKey)}"]`);
      const b = document.querySelector(`[data-pkey="${CSS.escape(toKey)}"]`);
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
    window.addEventListener("resize", computeLine);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(computeLine) : null;
    if (el && ro) ro.observe(el);
    return () => {
      if (el) el.removeEventListener("scroll", computeLine);
      window.removeEventListener("resize", computeLine);
      ro?.disconnect();
    };
  }, [resolvedSelectedLink]);

  const renderGroup = (devices: TopologyNode[], groupKey: string) => devices.map((d, idx) => (
    <div key={d.id} className="flex items-start gap-1.5 mb-1">
      <div className="flex flex-col gap-0.5 pt-2 shrink-0">
        <button
          type="button"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            applyLocalReorder(d.id, "up", groupKey, devices);
            onReorder?.(d.id, "up", groupKey);
          }}
          disabled={idx === 0}
          className={reorderBtnClass(idx === 0)}>^</button>
        <button
          type="button"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            applyLocalReorder(d.id, "down", groupKey, devices);
            onReorder?.(d.id, "down", groupKey);
          }}
          disabled={idx === devices.length - 1}
          className={reorderBtnClass(idx === devices.length - 1)}>v</button>
      </div>
      <div className="flex-1 min-w-0">
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

  const renderPlacedDevice = (d: TopologyNode) => (
    <div key={d.id} className="mb-1">
      <SwitchPanel device={d} otherRacks={otherRacks} onMove={onMoveDevice}
        onUpdateMeta={onUpdateDeviceMeta}
        portLinkMap={portLinkMap} selectedLink={resolvedSelectedLink}
        onPortClick={toggleLink} linkColorMap={linkColorMap}
        interRackPortKeys={interRackPortKeys}
        switchClass={d.class_id ? classMap[d.class_id] : null}
        switchModel={d.model_id ? modelMap[d.model_id] : null}
        onShowDetail={onShowDetail}
        highlightPortKey={highlightPortKey}
        uBadge={uBadgeLabel(d) ?? undefined}/>
    </div>
  );

  const renderLink = (l: TopologyLink, i: number, accentColor: string) => {
    const a = devByIp[l.local_ip], b = devByIp[l.remote_ip];
    const isSel = (resolvedSelectedLink?.local_ip===l.local_ip && resolvedSelectedLink?.local_port===l.local_port)
               || (resolvedSelectedLink?.remote_ip===l.local_ip && resolvedSelectedLink?.remote_port===l.local_port);
    return (
      <div
        key={i}
        onClick={() => toggleLink(l)}
        style={{
          borderLeft: isSel ? `3px solid ${accentColor}` : "3px solid transparent",
          backgroundColor: isSel ? `${accentColor}14` : "transparent",
        }}
        className="grid grid-cols-[1fr_64px_1fr] items-center px-3 py-1.5 border-b border-line cursor-pointer text-[10px] relative transition-colors"
      >
        <div className="min-w-0 pr-1.5">
          <div
            style={{ color: isSel ? accentColor : (VENDOR_COLOR[a?.vendor] || "var(--muted)") }}
            className="font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
          >{VENDOR_ICON[a?.vendor]||"[--]"} {a?.sys_name || l.local_ip}</div>
          <div className="text-muted text-[10px] mt-px">{l.local_port}</div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div
            className="w-full rounded-sm"
            style={{
              height: isSel ? 5 : 4,
              background: `linear-gradient(90deg, ${accentColor}cc, ${accentColor})`,
              boxShadow: isSel ? `0 0 10px ${accentColor}` : `0 0 6px ${accentColor}88`,
            }}
          />
          <span
            style={{ color: accentColor }}
            className="text-[10px] font-bold tracking-wider"
          >{l.speed_label}</span>
        </div>
        <div className="min-w-0 pl-1.5 text-right">
          <div
            style={{ color: isSel ? accentColor : (VENDOR_COLOR[b?.vendor] || "var(--muted)") }}
            className="font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
          >{b?.sys_name || l.remote_ip} {VENDOR_ICON[b?.vendor]||"[--]"}</div>
          <div className="text-muted text-[10px] mt-px">{l.remote_port}</div>
        </div>
      </div>
    );
  };

  const sectionHeaderClass = "text-[10px] mb-1.5 tracking-widest uppercase flex items-center gap-2";

  return (
    <>
    <div className="w-full h-full bg-surface border-l border-line flex flex-col animate-[slideIn_0.2s_ease]">
      <style>{`
        @keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @keyframes dashFlow{to{stroke-dashoffset:-12}}
      `}</style>

      {/* Header */}
      <div ref={panelHeaderRef} className="px-5 py-4 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex-1 min-w-0">
          {editing && canRename ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter")  commitRename();
                  if (e.key === "Escape") { setNameInput(rack.label); setEditing(false); }
                }}
                className="text-[15px] font-bold bg-panel-2 border border-accent text-primary rounded px-2 py-0.5 font-inherit outline-none w-44"
              />
              <button
                type="button"
                onClick={commitRename}
                className="bg-panel-2 border border-accent text-accent rounded px-2 py-0.5 cursor-pointer text-[11px]"
              >OK</button>
              <button
                type="button"
                onClick={() => { setNameInput(rack.label); setEditing(false); }}
                className="bg-transparent border border-line text-muted rounded px-2 py-0.5 cursor-pointer text-[11px]"
              >X</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="text-primary font-bold text-base">{rack.label}</div>
              {canRename && (
                <button
                  type="button"
                  onClick={() => { setNameInput(rack.label); setEditing(true); }}
                  title="Rename rack"
                  className="bg-transparent border border-line text-muted rounded px-1.5 py-0.5 cursor-pointer text-[11px] hover:text-accent hover:border-accent transition-colors"
                >Edit</button>
              )}
            </div>
          )}
          <div className="text-muted text-[11px] mt-0.5 flex gap-2.5">
            <span>{rack.location}</span>
            <span>{activePorts}/{totalPorts} ports active</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="bg-transparent border border-line text-muted rounded-md px-2.5 py-1 cursor-pointer text-base shrink-0 hover:text-primary transition-colors"
        >X</button>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-auto px-5 py-3">

        {placedDevices.length > 0 && (
          <div>
            <div className={`${sectionHeaderClass} text-accent`}>
              <span className="flex-1 h-0 inline-block border-b border-accent opacity-40"/>
              Rack elevation ({placedDevices.length})
              <span className="flex-1 h-0 inline-block border-b border-accent opacity-40"/>
            </div>
            {placedDevices.map(renderPlacedDevice)}
          </div>
        )}

        {placedDevices.length > 0 && unplacedDevices.length > 0 && (
          <div className={`${sectionHeaderClass} text-muted mt-4`}>
            <span className="flex-1 h-0 inline-block border-b border-line"/>
            Unplaced ({unplacedDevices.length})
            <Link
              to="/racks"
              className="text-accent hover:underline cursor-pointer"
              style={{ textTransform: "none", letterSpacing: "normal" }}
            >Place in rack elevation</Link>
            <span className="flex-1 h-0 inline-block border-b border-line"/>
          </div>
        )}

        {classSections.map((section, idx) => (
          <div key={section.key}>
            <div
              className={sectionHeaderClass}
              style={{ color: section.color, marginTop: idx === 0 ? 0 : 10 }}
            >
              <span className="flex-1 h-0 inline-block" style={{ borderBottom: `1px solid ${section.color}44` }}/>
              {section.label} ({section.devices.length})
              <span className="flex-1 h-0 inline-block" style={{ borderBottom: `1px solid ${section.color}44` }}/>
              <div className="flex gap-0.5 ml-1">
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
                  className={sectionReorderBtnClass(idx === 0)}
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
                  className={sectionReorderBtnClass(idx === classSections.length - 1)}
                >v</button>
              </div>
            </div>
            {renderGroup(section.devices, section.key)}
          </div>
        ))}

        {uplinks.length > 0 && (
          <>
            <div className={`${sectionHeaderClass} text-success mt-4`}>
              <span className="flex-1 h-0 inline-block border-b border-success opacity-40"/>
              Uplinks ({uplinks.length})
              <span className="flex-1 h-0 inline-block border-b border-success opacity-40"/>
            </div>
            <div className="bg-panel border border-line rounded-lg overflow-hidden">
              {uplinks.map((l, i) => renderLink(l, i, linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || CABLE_COLORS[i % CABLE_COLORS.length]))}
            </div>
          </>
        )}

        {trunks.length > 0 && (
          <>
            <div className={`${sectionHeaderClass} text-accent mt-3`}>
              <span className="flex-1 h-0 inline-block border-b border-accent opacity-40"/>
              TOR Trunks ({trunks.length})
              <span className="flex-1 h-0 inline-block border-b border-accent opacity-40"/>
            </div>
            <div className="bg-panel border border-line rounded-lg overflow-hidden">
              {trunks.map((l, i) => renderLink(l, i, linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || "var(--accent)"))}
            </div>
          </>
        )}

        {external.length > 0 && (
          <>
            <div className={`${sectionHeaderClass} text-external mt-4`}>
              <span className="flex-1 h-0 inline-block border-b border-external opacity-40"/>
              Inter-Rack ({external.length})
              <span className="flex-1 h-0 inline-block border-b border-external opacity-40"/>
            </div>
            <div className="bg-panel border border-line rounded-lg overflow-hidden">
              {external.map((l, i) => {
                const localDev = devByIp[l.local_ip];
                const remoteLabel = l.remoteRack?.label || l.remote_ip;
                return (
                  <div key={i} className="grid grid-cols-[1fr_80px_1fr] items-center px-3 py-1.5 border-b border-line text-[10px]">
                    <div className="min-w-0 pr-1.5">
                      <div
                        style={{ color: VENDOR_COLOR[localDev?.vendor] || "var(--muted)" }}
                        className="font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {VENDOR_ICON[localDev?.vendor]||"[--]"} {localDev?.sys_name || l.local_ip}
                      </div>
                      <div className="text-muted text-[10px] mt-px">{l.local_port}</div>
                    </div>
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="w-full h-[3px] rounded-sm bg-external shadow-[0_0_5px_var(--external)]"/>
                      <span className="text-[10px] text-external font-bold tracking-wider">{l.speed_label}</span>
                    </div>
                    <div className="min-w-0 pl-1.5 text-right">
                      <div className="text-external font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
                        {remoteLabel}
                      </div>
                      <div className="text-muted text-[10px] mt-px">{l.remote_port}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {allIntraLinks.length > 0 && (
          <div className="mt-3.5 px-3 py-2 bg-panel rounded-lg border border-line">
            <div className="text-muted text-[10px] mb-1.5 tracking-widest uppercase">Cable Map</div>
            {allIntraLinks.map((l, i) => {
              const c = linkColorMap[`${l.local_ip}:${normPort(l.local_port)}`] || CABLE_COLORS[i % CABLE_COLORS.length];
              const isSel = resolvedSelectedLink?.local_ip===l.local_ip && resolvedSelectedLink?.local_port===l.local_port;
              return (
                <div key={i} onClick={() => toggleLink(l)} style={{
                  backgroundColor: isSel ? `${c}14` : "transparent",
                }} className="flex items-center gap-2 mb-1 cursor-pointer px-1.5 py-0.5 rounded transition-colors">
                  <div style={{ backgroundColor: c }} className="w-6 h-0.5 rounded-sm shrink-0"/>
                  <span className="text-muted text-[10px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {devByIp[l.local_ip]?.sys_name||l.local_ip} {l.local_port} {"<->"} {l.remote_port} {devByIp[l.remote_ip]?.sys_name||l.remote_ip}
                  </span>
                  <span style={{
                    backgroundColor: `${c}18`, border: `1px solid ${c}33`, color: c,
                  }} className="px-1.5 py-px text-[10px] rounded shrink-0">{l.speed_label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-5 py-2 border-t border-line text-[10px] text-muted text-center shrink-0">
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
