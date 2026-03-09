import { useState, useMemo } from "react";
import { speedLabel, buildPortLinkMap, normPort, CABLE_COLORS } from "../api.js";

export default function SwitchDetailSlideIn({ deviceId, nodes, topologyLinks, rackPairColorMap, allRacks, onClose }) {
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

  const portLinkMap = useMemo(() => buildPortLinkMap(deviceLinks), [deviceLinks]);

  const linkColorMap = useMemo(() => {
    const ipToRackId = {};
    (allRacks || []).forEach(r => {
      if (r.id) (r.devices || []).forEach(d => { ipToRackId[d.ip] = String(r.id); });
    });
    const m = {};
    const pairColors = {};
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

  const columns = [
    { key: "if_index",      label: "PORT #",        align: "right" },
    { key: "if_descr",      label: "NAME",          align: "left" },
    { key: "oper_status",   label: "STATUS",        align: "center" },
    { key: "speed_mbps",    label: "SPEED",         align: "right" },
    { key: "vlan",          label: "NATIVE VLAN",   align: "right" },
    { key: "tagged_vlans",  label: "TAGGED VLANS",  align: "left" },
    { key: "peer_mac",      label: "MAC ADDRESS",   align: "left" },
    { key: "peer_ip",       label: "IP",            align: "left" },
    { key: "peer_host",     label: "HOSTNAME",      align: "left" },
  ];

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const sortedPorts = useMemo(() => {
    if (!device) return [];
    const list = [...device.ports];
    list.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === "tagged_vlans") {
        va = (va || []).length;
        vb = (vb || []).length;
      }
      if (typeof va === "string" && typeof vb === "string")
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      va = va ?? 0;
      vb = vb ?? 0;
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [device, sortCol, sortAsc]);

  if (!device) return null;

  const pingStatus = device.ping_status || "unknown";
  const statusColor = pingStatus === "online" ? "#22c55e"
    : pingStatus === "offline" ? "#f87171" : "#64748b";
  const activePorts = device.ports.filter(p => p.oper_status === 1);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
          zIndex: 1000,
        }}
      />

      {/* Slide-in panel */}
      <div style={{
        position: "fixed",
        top: 48, right: 0, bottom: 0,
        width: "80vw",
        maxWidth: 1400,
        backgroundColor: "#020817",
        borderLeft: "1px solid #1e293b",
        zIndex: 1001,
        display: "flex", flexDirection: "column",
        fontFamily: "'Inter', system-ui, sans-serif",
        animation: "slideInDetail 0.25s ease",
      }}>
        <style>{`
          @keyframes slideInDetail {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>

        {/* Header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: "1px solid #1e293b",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div title={pingStatus} style={{
                width: 10, height: 10, borderRadius: "50%",
                backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}`,
              }} />
              <span style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>
                {device.sys_name || device.ip}
              </span>
            </div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "#94a3b8" }}>
              <span><span style={{ color: "#475569" }}>IP:</span> {device.ip}</span>
              {device.vendor && <span><span style={{ color: "#475569" }}>Vendor:</span> {device.vendor}</span>}
              {device.model && <span><span style={{ color: "#475569" }}>Model:</span> {device.model}</span>}
              {device.location && <span><span style={{ color: "#475569" }}>Location:</span> {device.location}</span>}
              <span><span style={{ color: "#475569" }}>Ports:</span> {activePorts.length}/{device.ports.length} active</span>
              {device.ping_rtt_ms != null && pingStatus === "online" && (
                <span><span style={{ color: "#475569" }}>RTT:</span> {device.ping_rtt_ms}ms</span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid #1e293b",
            color: "#64748b", borderRadius: 6, padding: "4px 10px",
            cursor: "pointer", fontSize: 16, flexShrink: 0,
          }}>X</button>
        </div>

        {/* Port table (scrollable) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
          <div style={{
            backgroundColor: "#0a0e18", border: "1px solid #1e293b",
            borderRadius: 10, padding: "20px 24px",
          }}>
            <div style={{
              fontSize: 10, color: "#475569", letterSpacing: "0.08em",
              textTransform: "uppercase", marginBottom: 14,
            }}>
              Ports ({device.ports.length})
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e293b" }}>
                    {columns.map(col => (
                      <th key={col.key}
                        onClick={() => handleSort(col.key)}
                        style={{
                          padding: "8px 10px", color: sortCol === col.key ? "#e2e8f0" : "#475569",
                          fontWeight: 600, fontSize: 9, letterSpacing: 1,
                          textAlign: col.align, cursor: "pointer", userSelect: "none",
                          whiteSpace: "nowrap",
                        }}>
                        {col.label}{sortCol === col.key ? (sortAsc ? " ^" : " v") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedPorts.map(port => {
                    const pKey = `${device.ip}:${normPort(port.if_descr)}`;
                    const cableColor = linkColorMap[pKey];
                    const linkEntry = portLinkMap[pKey];
                    const partnerIp = linkEntry
                      ? (linkEntry.role === "from" ? linkEntry.link.remote_ip : linkEntry.link.local_ip)
                      : null;
                    return (
                      <tr key={port.id} style={{
                        borderBottom: "1px solid #0f172a",
                        borderLeft: cableColor ? `3px solid ${cableColor}` : "3px solid transparent",
                        backgroundColor: cableColor ? `${cableColor}08` : undefined,
                      }}>
                        <td style={{ padding: "8px 10px", color: "#94a3b8", textAlign: "right" }}>
                          {port.if_index}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#e2e8f0", fontWeight: 500 }}>
                          {port.if_descr || "-"}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "center" }}>
                          <span style={{
                            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                            backgroundColor: port.oper_status === 1 ? "#22c55e" : "#334155",
                            boxShadow: port.oper_status === 1 ? "0 0 4px #22c55e" : "none",
                          }} />
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8", textAlign: "right" }}>
                          {port.speed_mbps ? speedLabel(port.speed_mbps) : "-"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#7dd3fc", textAlign: "right" }}>
                          {port.vlan || "-"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8" }}>
                          {port.tagged_vlans && port.tagged_vlans.length > 0
                            ? port.tagged_vlans.join(", ")
                            : "-"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
                          {port.peer_mac || "-"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 10 }}>
                          {partnerIp && (
                            <span style={{ color: cableColor || "#22d3ee" }} title="Link partner">
                              {partnerIp}
                            </span>
                          )}
                          {partnerIp && port.peer_ip && (
                            <span style={{ color: "#334155" }}>{" | "}</span>
                          )}
                          {port.peer_ip && (
                            <span>{port.peer_ip}</span>
                          )}
                          {!partnerIp && !port.peer_ip && "-"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8" }}>
                          {port.peer_host || "-"}
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
