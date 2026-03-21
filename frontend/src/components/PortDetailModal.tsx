import { speedLabel, speedColor } from "../api";

interface PortData {
  if_descr?: string;
  if_index?: number;
  oper_status: number;
  speed_mbps?: number;
  vlan?: number | null;
  tagged_vlans?: number[];
  endpoint_count?: number;
}

interface Props {
  port: PortData;
  onClose: () => void;
}

export default function PortDetailModal({ port, onClose }: Props) {
  const endpointCount = Number(port.endpoint_count || 0);
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
          <span style={{ color: "#22d3ee" }}>{endpointCount}</span>
        </div>

        {/* Endpoint info */}
        <div style={{ padding: 8, color: "#475569", fontSize: 11 }}>
          {endpointCount === 0
            ? "No endpoints connected to this port"
            : `${endpointCount} endpoint(s) connected -- see Devices page for details`}
        </div>
      </div>
    </div>
  );
}
