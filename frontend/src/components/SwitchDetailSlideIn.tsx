import { useState, useMemo } from "react";
import { normPort } from "../api";
import { speedLabel, CABLE_COLORS } from "../theme/visual";
import type { TopologyNode, TopologyLink } from "../types";

interface SwitchDetailSlideInProps {
  deviceId: number | string;
  nodes: TopologyNode[];
  topologyLinks: TopologyLink[];
  rackPairColorMap?: Record<string, string>;
  allRacks?: { id: number | string; label?: string; devices?: TopologyNode[] }[];
  onClose: () => void;
}

interface ColumnDef {
  key: string;
  label: string;
  align: "left" | "center" | "right";
}

export default function SwitchDetailSlideIn({ deviceId, nodes, topologyLinks, rackPairColorMap, allRacks, onClose }: SwitchDetailSlideInProps) {
  const [sortCol, setSortCol] = useState("if_index");
  const [sortAsc, setSortAsc] = useState(true);

  const device = useMemo(
    () => (nodes || []).find(n => n.id === Number(deviceId)),
    [nodes, deviceId]
  );

  const deviceLinks = useMemo(() => {
    if (!device || !topologyLinks) return [];
    return topologyLinks.filter(
      l => l.local_ip === device.ip || l.remote_ip === device.ip
    );
  }, [device, topologyLinks]);

  const linkColorMap = useMemo(() => {
    const ipToRackId: Record<string, string> = {};
    (allRacks || []).forEach(r => {
      if (r.id) (r.devices || []).forEach(d => { ipToRackId[d.ip] = String(r.id); });
    });
    const m: Record<string, string> = {};
    const pairColors: Record<string, string> = {};
    let colorIdx = 0;
    deviceLinks.forEach(l => {
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
      m[`${l.local_ip}:${normPort(l.local_port)}`] = c;
      m[`${l.remote_ip}:${normPort(l.remote_port)}`] = c;
    });
    return m;
  }, [deviceLinks, allRacks, rackPairColorMap]);

  const columns: ColumnDef[] = [
    { key: "if_index",      label: "PORT #",        align: "right" },
    { key: "if_descr",      label: "NAME",          align: "left" },
    { key: "oper_status",   label: "STATUS",        align: "center" },
    { key: "speed_mbps",    label: "SPEED",         align: "right" },
    { key: "vlan",          label: "NATIVE VLAN",   align: "right" },
    { key: "tagged_vlans",  label: "TAGGED VLANS",  align: "left" },
    { key: "endpoint_count",label: "ENDPOINTS",     align: "right" },
  ];

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const sortedPorts = useMemo(() => {
    if (!device) return [];
    const list = [...device.ports];
    list.sort((a, b) => {
      let va: unknown = a[sortCol];
      let vb: unknown = b[sortCol];
      if (sortCol === "tagged_vlans") {
        va = (Array.isArray(va) ? va : []).length;
        vb = (Array.isArray(vb) ? vb : []).length;
      }
      if (typeof va === "string" && typeof vb === "string")
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      const na = (va as number) ?? 0;
      const nb = (vb as number) ?? 0;
      return sortAsc ? na - nb : nb - na;
    });
    return list;
  }, [device, sortCol, sortAsc]);

  if (!device) return null;

  const pingStatus = (device.ping_status as string) || "unknown";
  const statusColor = pingStatus === "online" ? "var(--success)"
    : pingStatus === "offline" ? "var(--danger)" : "var(--muted)";
  const activePorts = device.ports.filter(p => p.oper_status === 1);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/40 z-[1000]"
      />

      {/* Slide-in panel */}
      <div className="fixed top-12 right-0 bottom-0 w-[80vw] max-w-[1400px] bg-surface border-l border-line z-[1001] flex flex-col animate-[slideInDetail_0.25s_ease]">
        <style>{`
          @keyframes slideInDetail {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>

        {/* Header */}
        <div className="px-5 py-4 border-b border-line flex items-start justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2.5 mb-2">
              <div title={pingStatus} style={{
                backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}`,
              }} className="w-2.5 h-2.5 rounded-full" />
              <span className="text-lg font-bold text-primary">
                {device.sys_name || device.ip}
              </span>
            </div>
            <div className="flex gap-6 flex-wrap text-xs text-muted">
              <span><span className="opacity-70">IP:</span> {device.ip}</span>
              {device.vendor && <span><span className="opacity-70">Vendor:</span> {device.vendor}</span>}
              {device.model && <span><span className="opacity-70">Model:</span> {device.model}</span>}
              {device.location && <span><span className="opacity-70">Location:</span> {String(device.location)}</span>}
              <span><span className="opacity-70">Ports:</span> {activePorts.length}/{device.ports.length} active</span>
              {device.ping_rtt_ms != null && pingStatus === "online" && (
                <span><span className="opacity-70">RTT:</span> {device.ping_rtt_ms}ms</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="bg-transparent border border-line text-muted rounded-md px-2.5 py-1 cursor-pointer text-base shrink-0 hover:text-primary transition-colors"
          >X</button>
        </div>

        {/* Port table (scrollable) */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <div className="bg-panel border border-line rounded-lg px-6 py-5">
            <div className="text-[10px] text-muted tracking-widest uppercase mb-3.5">
              Ports ({device.ports.length})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-line">
                    {columns.map(col => (
                      <th key={col.key}
                        onClick={() => handleSort(col.key)}
                        style={{ textAlign: col.align }}
                        className={`px-2.5 py-2 font-semibold text-[9px] tracking-widest cursor-pointer select-none whitespace-nowrap ${
                          sortCol === col.key ? "text-primary" : "text-muted"
                        }`}>
                        {col.label}{sortCol === col.key ? (sortAsc ? " ^" : " v") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedPorts.map(port => {
                    const pKey = `${device.ip}:${normPort(port.if_descr || "")}`;
                    const cableColor = linkColorMap[pKey];
                    return (
                      <tr key={port.id} style={{
                        borderLeft: cableColor ? `3px solid ${cableColor}` : "3px solid transparent",
                        backgroundColor: cableColor ? `${cableColor}08` : undefined,
                      }} className="border-b border-line">
                        <td className="px-2.5 py-2 text-muted text-right">
                          {port.if_index}
                        </td>
                        <td className="px-2.5 py-2 text-primary font-medium">
                          {port.if_descr || "-"}
                        </td>
                        <td className="px-2.5 py-2 text-center">
                          <span
                            className="inline-block w-2 h-2 rounded-full"
                            style={{
                              backgroundColor: port.oper_status === 1 ? "var(--success)" : "var(--line-strong)",
                              boxShadow: port.oper_status === 1 ? "0 0 4px var(--success)" : "none",
                            }}
                          />
                        </td>
                        <td className="px-2.5 py-2 text-muted text-right">
                          {port.speed_mbps ? speedLabel(port.speed_mbps) : "-"}
                        </td>
                        <td className="px-2.5 py-2 text-accent text-right">
                          {port.vlan || "-"}
                        </td>
                        <td className="px-2.5 py-2 text-muted">
                          {port.tagged_vlans && port.tagged_vlans.length > 0
                            ? port.tagged_vlans.join(", ")
                            : "-"}
                        </td>
                        <td className="px-2.5 py-2 text-accent text-right">
                          {port.endpoint_count || 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
