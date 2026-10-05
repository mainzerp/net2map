import { Handle, Position, type NodeProps } from "@xyflow/react";
import { StatusDot } from "../../../components/ui";
import { VENDOR_COLOR, VENDOR_ICON, VENDOR_LABEL } from "../../../theme/visual";
import type { DeviceFlowNode } from "../flowTypes";

// ── DeviceNode ───────────────────────────────────────────────────────────────
// A single switch on the canvas: either an outside (unracked) device or a
// member device inside an expanded rack group.

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

function pingToStatus(ping: string | undefined): "up" | "down" | "unknown" {
  if (ping === "online") return "up";
  if (ping === "offline") return "down";
  return "unknown";
}

export default function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, classColor } = data;
  const vendorColor = VENDOR_COLOR[device.vendor] || "var(--muted)";
  const vendorIcon = VENDOR_ICON[device.vendor] || "[--]";
  const vendorLabel = VENDOR_LABEL[device.vendor] || device.vendor;
  const pingStatus = device.ping_status || "unknown";
  const totalPorts = (device.ports || []).length;
  const activePorts = (device.ports || []).filter(p => p.oper_status === 1).length;
  const name = device.sys_name || device.ip;

  return (
    <div
      className={`w-full h-full rounded-lg border bg-panel px-3 py-2 flex flex-col justify-center gap-0.5 cursor-pointer active:cursor-grabbing transition-shadow duration-[120ms] motion-reduce:transition-none ${
        selected ? "border-accent shadow-[0_0_14px_var(--accent)]" : "border-line-strong hover:ring-2 hover:ring-accent/40"
      }`}
      title={`${name} - click to open details`}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <span
        className="absolute left-0 top-2 bottom-2 w-1 rounded-r"
        style={{ backgroundColor: classColor || vendorColor, opacity: 0.9 }}
      />
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="font-mono text-[10px] font-bold shrink-0"
          style={{ color: vendorColor }}
          title={vendorLabel}
        >
          {vendorIcon}
        </span>
        <span
          className={`text-[12px] font-semibold truncate ${selected ? "text-accent" : "text-primary"}`}
          title={name}
        >
          {name}
        </span>
        <span className="ml-auto shrink-0" title={`ping ${pingStatus}`}>
          <StatusDot status={pingToStatus(pingStatus)} />
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted font-mono">
        <span className="truncate">{device.ip}</span>
        {pingStatus === "online" && device.ping_rtt_ms != null && (
          <span className="shrink-0">{device.ping_rtt_ms}ms</span>
        )}
        <span className="ml-auto shrink-0">
          {activePorts}/{totalPorts}
        </span>
      </div>
    </div>
  );
}
