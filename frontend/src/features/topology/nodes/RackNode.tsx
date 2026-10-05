import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useScanPulse } from "../zoomTier";
import type { RackFlowNode } from "../flowTypes";
import OverlayBadges from "./OverlayBadges";

// ── RackNode ─────────────────────────────────────────────────────────────────
// A collapsed rack box: class color strips on top, label, port counters and
// device count. Clicking the node opens the RackDetail side panel.
// Counters carry topo-detail so the far zoom tier shows the label only.

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

function RackNode({ data, selected }: NodeProps<RackFlowNode>) {
  const { rack, devices, classColors, activePorts, totalPorts, overlay } = data;
  const pulseIps = useScanPulse();
  const pulse = pulseIps.size > 0 && devices.some(d => pulseIps.has(d.ip));

  return (
    <div
      className={`topo-node w-full h-full rounded-lg border bg-panel flex flex-col items-center justify-center gap-1 cursor-pointer active:cursor-grabbing relative transition-[border-color,box-shadow,opacity] duration-[120ms] motion-reduce:transition-none ${
        selected ? "border-accent ring-1 ring-accent" : "border-line-strong hover:border-accent"
      } ${pulse ? "topo-scan-ring" : ""}`}
      data-node-kind="rack"
      data-overlay-dim={overlay && overlay.dim !== "none" ? overlay.dim : undefined}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <OverlayBadges overlay={overlay} />
      {classColors.length > 0 && (
        <span className="absolute top-1.5 left-2 right-2 flex gap-1">
          {classColors.map((c, i) => (
            <span
              key={i}
              className="h-1 rounded-full"
              style={{ backgroundColor: c, width: `${100 / classColors.length}%`, opacity: 0.85 }}
            />
          ))}
        </span>
      )}
      <span className={`topo-node-label font-mono font-bold text-[13px] mt-1 ${selected ? "text-accent" : "text-primary"}`}>
        {rack.label}
      </span>
      {totalPorts > 0 && (
        <span className="topo-detail text-muted text-[10px] font-mono tabular-nums">
          {activePorts}/{totalPorts} ports active
        </span>
      )}
      <span className="topo-detail text-muted text-[9px] font-mono tabular-nums">
        {devices.length} device{devices.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export default memo(RackNode);
