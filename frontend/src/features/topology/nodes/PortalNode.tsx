import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, Layers } from "lucide-react";
import type { PortalFlowNode } from "../flowTypes";

// ── PortalNode ───────────────────────────────────────────────────────────────
// Stand-in for a linked rack/device on another floor. Placed automatically
// next to its local endpoint (never persisted); clicking it switches the map
// to the remote floor and focuses the remote device (TopologyCanvas).

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

function PortalNode({ data, selected }: NodeProps<PortalFlowNode>) {
  return (
    <div
      className={`topo-node relative w-full h-full rounded-full border border-dashed bg-panel-2 px-3 flex items-center gap-1.5 cursor-pointer transition-[border-color] duration-[120ms] motion-reduce:transition-none ${
        selected ? "border-accent" : "border-line-strong hover:border-accent"
      }`}
      title={`${data.label} - click to switch floor`}
      data-node-kind="portal"
      data-testid="portal-node"
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <Layers size={12} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 truncate text-[11px] text-primary">
        <span className="text-muted">{data.floorLabel} / </span>
        <span className="font-semibold">{data.targetLabel}</span>
      </span>
      <ArrowUpRight size={12} strokeWidth={1.75} className="ml-auto shrink-0 text-accent" aria-hidden="true" />
    </div>
  );
}

export default memo(PortalNode);
