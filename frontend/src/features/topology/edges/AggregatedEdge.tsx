import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { getBorderAnchor, nodeCenter } from "./floating";
import type { AggregatedFlowEdge, TopoFlowNode } from "../flowTypes";

// ── AggregatedEdge ───────────────────────────────────────────────────────────
// One edge per endpoint pair (rack<->rack, rack<->device, device<->device).
// Both endpoints float: they anchor on the node border point facing the peer
// (see floating.ts) instead of a fixed handle, so links leave a node from the
// side the peer is on and track live while dragging. The badge shows the
// aggregated link count and best speed, e.g. "3x 10G". An active edge is the
// one whose pair contains the link currently selected in RackDetail.

export default function AggregatedEdge({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<AggregatedFlowEdge>) {
  const sourceNode = useInternalNode<TopoFlowNode>(source);
  const targetNode = useInternalNode<TopoFlowNode>(target);

  if (!sourceNode || !targetNode) return null;

  const sourceAnchor = getBorderAnchor(sourceNode, nodeCenter(targetNode));
  const targetAnchor = getBorderAnchor(targetNode, nodeCenter(sourceNode));

  const [path, labelX, labelY] = getBezierPath({
    sourceX: sourceAnchor.x,
    sourceY: sourceAnchor.y,
    sourcePosition: sourceAnchor.position,
    targetX: targetAnchor.x,
    targetY: targetAnchor.y,
    targetPosition: targetAnchor.position,
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
