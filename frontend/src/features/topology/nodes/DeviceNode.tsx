import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BatteryCharging, Server, type LucideIcon } from "lucide-react";
import { StatusDot } from "../../../components/ui";
import VendorBadge from "../../../components/map/VendorBadge";
import { VENDOR_COLOR, speedColor } from "../../../theme/visual";
import type { DeviceType, PortInfo } from "../../../types";
import {
  DEVICE_TYPE_LABEL,
  HEALTH_STATUS_LABEL,
  deviceTypeOf,
  healthOf,
  healthStatusBg,
  isPowerOrServer,
} from "../../../utils/deviceHealth";
import { useScanPulse, useZoomTier } from "../zoomTier";
import type { DeviceFlowNode } from "../flowTypes";
import OverlayBadges from "./OverlayBadges";

// ── DeviceNode ───────────────────────────────────────────────────────────────
// A single switch on the canvas: either an outside (unracked) device or a
// member device inside an expanded rack group.
// Semantic zoom: elements tagged topo-detail are hidden at the far tier via
// CSS (data-zoom-tier on the canvas wrapper); the mini port strip is only
// mounted at the close tier so the far/mid DOM stays light.

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

// Upper bound for the mini port strip; larger chassis show the first ports.
export const PORT_STRIP_MAX = 52;

// Type icon next to the vendor badge; switches and firewalls need none.
const TYPE_ICON: Partial<Record<DeviceType, LucideIcon>> = { ups: BatteryCharging, server: Server };

function pingToStatus(ping: string | undefined): "up" | "down" | "unknown" {
  if (ping === "online") return "up";
  if (ping === "offline") return "down";
  return "unknown";
}

function portName(p: PortInfo): string {
  return p.name || p.if_descr || p.port_id;
}

const PortStrip = memo(function PortStrip({ ports }: { ports: PortInfo[] }) {
  const sorted = [...ports].sort((a, b) => (a.if_index ?? 0) - (b.if_index ?? 0));
  const shown = sorted.slice(0, PORT_STRIP_MAX);
  if (shown.length === 0) return null;
  return (
    <div
      className="topo-port-strip absolute left-2 right-2 top-full mt-1 flex flex-wrap gap-[2px] rounded-b-md border border-t-0 border-line bg-panel px-1.5 py-1"
      aria-label={`${ports.filter(p => p.oper_status === 1).length} of ${ports.length} ports up`}
      role="img"
    >
      {shown.map(p => {
        const up = p.oper_status === 1;
        const mbps = p.speed_mbps ?? p.speed ?? 0;
        return (
          <span
            key={p.id ?? p.port_id}
            className={`w-[6px] h-[6px] rounded-[1px] ${up ? "" : "border border-line-strong bg-panel-2"}`}
            style={up ? { backgroundColor: speedColor(mbps) } : undefined}
            title={`${portName(p)} ${up ? "up" : "down"}`}
          />
        );
      })}
      {sorted.length > PORT_STRIP_MAX && (
        <span className="text-[8px] leading-[6px] text-muted font-mono tabular-nums">
          +{sorted.length - PORT_STRIP_MAX}
        </span>
      )}
    </div>
  );
});

function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, classColor, overlay } = data;
  const tier = useZoomTier();
  const pulse = useScanPulse().has(device.ip);
  const vendorColor = VENDOR_COLOR[device.vendor] || "var(--muted)";
  const pingStatus = device.ping_status || "unknown";
  const ports = device.ports || [];
  const totalPorts = ports.length;
  const activePorts = ports.filter(p => p.oper_status === 1).length;
  const name = device.sys_name || device.ip;
  const deviceType = deviceTypeOf(device);
  const powerOrServer = isPowerOrServer(device);
  const health = healthOf(device);
  const TypeIcon = TYPE_ICON[deviceType];

  return (
    <div
      className={`topo-node relative w-full h-full rounded-lg border bg-panel px-3 py-2 flex flex-col justify-center gap-0.5 cursor-pointer active:cursor-grabbing transition-[border-color,box-shadow,opacity] duration-[120ms] motion-reduce:transition-none ${
        selected ? "border-accent ring-1 ring-accent" : "border-line-strong hover:border-accent"
      } ${pulse ? "topo-scan-ring" : ""}`}
      title={`${name} - click to open details`}
      data-node-kind="device"
      data-overlay-dim={overlay && overlay.dim !== "none" ? overlay.dim : undefined}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <OverlayBadges overlay={overlay} />
      <span
        className="absolute left-0 top-2 bottom-2 w-1 rounded-r"
        style={{ backgroundColor: classColor || vendorColor, opacity: 0.9 }}
      />
      <div className="flex items-center gap-2 min-w-0">
        <VendorBadge vendor={device.vendor} className="topo-detail" />
        {TypeIcon && (
          <TypeIcon
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted"
            aria-label={DEVICE_TYPE_LABEL[deviceType]}
            data-testid="node-type-icon"
          />
        )}
        <span
          className={`topo-node-label text-[12px] font-semibold truncate ${selected ? "text-accent" : "text-primary"}`}
          title={name}
        >
          {name}
        </span>
        <span className="topo-detail ml-auto shrink-0" title={`ping ${pingStatus}`}>
          <StatusDot status={pingToStatus(pingStatus)} />
        </span>
      </div>
      <div className="topo-detail flex items-center gap-2 text-[10px] text-muted font-mono tabular-nums">
        <span className="truncate">{device.ip}</span>
        {pingStatus === "online" && device.ping_rtt_ms != null && (
          <span className="shrink-0">{device.ping_rtt_ms}ms</span>
        )}
        {powerOrServer ? (
          health && (
            <span
              className="ml-auto shrink-0 inline-flex items-center gap-1"
              title={`Health: ${HEALTH_STATUS_LABEL[health.status] ?? health.status}`}
              data-testid="node-health"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${healthStatusBg(health.status)}`} />
              {health.kind === "ups" && health.charge_percent != null ? `${health.charge_percent}%` : null}
            </span>
          )
        ) : (
          <span className="ml-auto shrink-0">
            {activePorts}/{totalPorts}
          </span>
        )}
      </div>
      {tier === "close" && !powerOrServer && <PortStrip ports={ports} />}
    </div>
  );
}

export default memo(DeviceNode);
