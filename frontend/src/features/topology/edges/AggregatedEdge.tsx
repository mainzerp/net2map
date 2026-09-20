import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { AggregatedFlowEdge } from "../flowTypes";

// ── AggregatedEdge ───────────────────────────────────────────────────────────
// One edge per endpoint pair (rack<->rack, rack<->device). The badge shows the
// aggregated link count and best speed, e.g. "3x 10G". An active edge is the
// one whose pair contains the link currently selected in RackDetail.

export default function AggregatedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AggregatedFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const active = !!data?.active || selected;
  const color = data?.color || "var(--line-strong)";
  const width = (data?.width || 1.5) + (active ? 1.5 : 0);

  return (
    <>
      {active && (
        <BaseEdge
          id={`${id}-glow`}
          path={path}
          style={{ stroke: color, strokeWidth: width + 7, strokeOpacity: 0.15 }}
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: color, strokeWidth: width, strokeOpacity: active ? 0.95 : 0.6 }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            color,
            borderColor: color,
          }}
          className={`absolute nodrag nopan pointer-events-none px-1.5 py-0.5 rounded border bg-surface font-mono text-[9px] font-bold tracking-wide ${
            active ? "opacity-100" : "opacity-80"
          }`}
        >
          {data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
