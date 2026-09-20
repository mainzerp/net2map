import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RackFlowNode } from "../flowTypes";

// ── RackNode ─────────────────────────────────────────────────────────────────
// Collapsed: a compact box with class color strips and port counters.
// Expanded: a group frame; member devices render as child nodes inside it.

const handleStyle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

export default function RackNode({ data, selected }: NodeProps<RackFlowNode>) {
  const { rack, devices, classColors, activePorts, totalPorts, expanded, onToggleExpand } = data;

  const expandButton = (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        onToggleExpand(rack.id);
      }}
      title={expanded ? "Collapse rack" : "Expand rack"}
      className="nodrag inline-flex items-center justify-center w-5 h-5 rounded border border-line-strong bg-panel-2 text-muted hover:text-accent hover:border-accent transition-colors cursor-pointer text-[10px] leading-none"
    >
      {expanded ? "-" : "+"}
    </button>
  );

  if (expanded) {
    return (
      <div
        className={`w-full h-full rounded-xl border-2 bg-panel/40 ${
          selected ? "border-accent" : "border-line-strong border-dashed"
        }`}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
        <div className="flex items-center gap-2 h-12 px-3 border-b border-line">
          {classColors.length > 0 && (
            <span className="flex gap-1">
              {classColors.map((c, i) => (
                <span key={i} className="inline-block w-4 h-1.5 rounded-full" style={{ backgroundColor: c }} />
              ))}
            </span>
          )}
          <span className={`font-mono font-bold text-[13px] ${selected ? "text-accent" : "text-primary"}`}>
            {rack.label}
          </span>
          <span className="text-muted text-[10px]">
            {devices.length} device{devices.length === 1 ? "" : "s"}
          </span>
          <span className="ml-auto">{expandButton}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`w-full h-full rounded-lg border bg-panel flex flex-col items-center justify-center gap-1 cursor-grab active:cursor-grabbing ${
        selected ? "border-accent shadow-[0_0_14px_var(--accent)]" : "border-line-strong"
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
      <span className="absolute bottom-1.5 right-1.5">{expandButton}</span>
    </div>
  );
}
