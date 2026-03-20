import { useState, useMemo } from "react";
import { speedLabel, speedColor } from "../api";
import type { EndpointDetail } from "../types";

interface PortData {
  if_descr?: string;
  if_index?: number;
  oper_status: number;
  speed_mbps?: number;
  vlan?: number | null;
  tagged_vlans?: number[];
  endpoint_details_json?: string | unknown[] | null;
}

interface Props {
  port: PortData;
  onClose: () => void;
}

export default function PortDetailModal({ port, onClose }: Props) {
  const [filter, setFilter] = useState("");

  const parsedEndpoints = useMemo<EndpointDetail[]>(() => {
    try {
      const raw = port.endpoint_details_json;
      if (!raw) return [];
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }, [port.endpoint_details_json]);

  const filtered = useMemo(() => {
    if (!filter) return parsedEndpoints;
    const q = filter.toLowerCase();
    return parsedEndpoints.filter(ep =>
      (ep.mac || "").toLowerCase().includes(q) ||
      (ep.ip || "").toLowerCase().includes(q) ||
      (ep.host || "").toLowerCase().includes(q)
    );
  }, [parsedEndpoints, filter]);

  const active = port.oper_status === 1;
  const statusLabel = active ? "Up" : "Down";
  const statusColor = active ? "#4ade80" : "#f87171";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        style={{
          backgroundColor: "#0a0e18",
          border: "1px solid #1e293b",
          borderRadius: 12,
          padding: "24px 28px",
          minWidth: 420,
          maxWidth: 640,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          fontFamily: "'Inter', system-ui, sans-serif",
          color: "#e2e8f0",
          fontSize: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Port {port.if_descr || port.if_index}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "1px solid #334155",
              color: "#94a3b8", borderRadius: 4, width: 24, height: 24,
              cursor: "pointer", fontSize: 12, lineHeight: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >X</button>
        </div>

        {/* Port metadata */}
        <div style={{
          display: "grid", gridTemplateColumns: "90px 1fr",
          rowGap: 6, marginBottom: 16, padding: "10px 12px",
          backgroundColor: "#020817", border: "1px solid #1e293b", borderRadius: 8,
        }}>
          <span style={{ color: "#475569" }}>Port</span>
          <span>{port.if_descr || "-"}</span>
          <span style={{ color: "#475569" }}>Status</span>
          <span style={{ color: statusColor }}>{statusLabel}</span>
          <span style={{ color: "#475569" }}>Speed</span>
          <span style={{ color: speedColor(port.speed_mbps ?? 0) }}>{speedLabel(port.speed_mbps ?? 0)}</span>
          {port.vlan != null && port.vlan > 0 && <>
            <span style={{ color: "#475569" }}>VLAN</span>
            <span>{port.vlan}</span>
          </>}
          {port.tagged_vlans && port.tagged_vlans.length > 0 && <>
            <span style={{ color: "#475569" }}>Tagged</span>
            <span>{port.tagged_vlans.join(", ")}</span>
          </>}
          <span style={{ color: "#475569" }}>Endpoints</span>
          <span style={{ color: "#22d3ee" }}>{parsedEndpoints.length}</span>
        </div>

        {/* Filter */}
        {parsedEndpoints.length > 1 && (
          <input
            value={filter}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilter(e.target.value)}
            placeholder="Filter by MAC, IP, or hostname..."
            style={{
              marginBottom: 12, padding: "7px 10px",
              backgroundColor: "#020817", border: "1px solid #1e293b",
              borderRadius: 6, color: "#e2e8f0", fontSize: 11,
              fontFamily: "'Inter', system-ui, sans-serif",
              outline: "none",
            }}
          />
        )}

        {/* Endpoint table */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {parsedEndpoints.length === 0 ? (
            <div style={{ color: "#475569", fontSize: 11, padding: 8 }}>
              No endpoint details available
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1e293b" }}>
                  <th style={{ padding: "6px 8px", textAlign: "left", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1 }}>MAC</th>
                  <th style={{ padding: "6px 8px", textAlign: "left", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1 }}>IP</th>
                  <th style={{ padding: "6px 8px", textAlign: "left", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1 }}>HOSTNAME</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ep, idx) => (
                  <tr key={`${ep.mac || ""}-${ep.ip || ""}-${idx}`} style={{ borderBottom: "1px solid #0f172a" }}>
                    <td style={{ padding: "5px 8px", color: "#94a3b8", fontFamily: "monospace" }}>{ep.mac || "-"}</td>
                    <td style={{ padding: "5px 8px", color: "#7dd3fc" }}>{ep.ip || "-"}</td>
                    <td style={{ padding: "5px 8px", color: "#e2e8f0" }}>{ep.host || "-"}</td>
                  </tr>
                ))}
                {filtered.length === 0 && parsedEndpoints.length > 0 && (
                  <tr>
                    <td colSpan={3} style={{ padding: "8px", color: "#475569", fontSize: 11 }}>
                      No matches for "{filter}"
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
