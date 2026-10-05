import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RackFlowNode } from "../flowTypes";

// ── RackNode ─────────────────────────────────────────────────────────────────
// A collapsed rack box: class color strips on top, label, port counters and
// device count. Clicking the node opens the RackDetail side panel.

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

export default function RackNode({ data, selected }: NodeProps<RackFlowNode>) {
  const { rack, devices, classColors, activePorts, totalPorts } = data;

  return (
    <div
      className={`w-full h-full rounded-lg border bg-panel flex flex-col items-center justify-center gap-1 cursor-pointer active:cursor-grabbing relative transition-shadow duration-[120ms] motion-reduce:transition-none ${
        selected ? "border-accent shadow-[0_0_14px_var(--accent)]" : "border-line-strong hover:ring-2 hover:ring-accent/40"
      }`}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
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
      <span className={`font-mono font-bold text-[13px] mt-1 ${selected ? "text-accent" : "text-primary"}`}>
        {rack.label}
      </span>
      {totalPorts > 0 && (
        <span className="text-muted text-[10px] font-mono">
          {activePorts}/{totalPorts} ports active
        </span>
      )}
      <span className="text-muted text-[9px] font-mono">
        {devices.length} device{devices.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}
