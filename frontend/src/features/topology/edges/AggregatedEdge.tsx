import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { getBorderAnchor, nodeCenter } from "./floating";
import { useFlowEnabled } from "../flowContext";
import type { AggregatedFlowEdge, TopoFlowNode } from "../flowTypes";

// ── AggregatedEdge ───────────────────────────────────────────────────────────
// One edge per endpoint pair (rack<->rack, rack<->device, device<->device).
// Both endpoints float: they anchor on the node border point facing the peer
// (see floating.ts) instead of a fixed handle, so links leave a node from the
// side the peer is on and track live while dragging. The badge shows the
// aggregated link count and best speed, e.g. "3x 10G". An active edge is the
// one whose pair contains the link currently selected in RackDetail.
//
// Cartographic look, drawn as up to three stacked paths:
//  1. casing: a wider stroke in the surface color that separates the line from
//     the paper grid and from crossing links (like the halo of a map road),
//  2. ink: the link itself; width encodes speed (speedStrokeWidth), round
//     caps; down/unknown links are dashed in the muted color,
//  3. flow (optional): a slow dash pattern animated purely in CSS
//     (.topo-edge-flow in index.css) for links that are up.

const DOWN_DASH = "4 4";

function AggregatedEdge({ id, source, target, data, selected }: EdgeProps<AggregatedFlowEdge>) {
  const sourceNode = useInternalNode<TopoFlowNode>(source);
  const targetNode = useInternalNode<TopoFlowNode>(target);
  const flowEnabled = useFlowEnabled();

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

  const active = !!data?.active || !!selected;
  const status = data?.status ?? "up";
  const up = status === "up";
  const baseWidth = data?.width || 1.5;
  const width = baseWidth + (active ? 1 : 0);
  const color = active ? "var(--accent)" : up ? data?.color || "var(--line-strong)" : "var(--muted)";

  return (
    <>
      <path
        d={path}
        fill="none"
        className="topo-edge-casing"
        stroke="var(--surface)"
        strokeWidth={width + 3}
        strokeLinecap="round"
        strokeOpacity={0.9}
        pointerEvents="none"
      />
      <BaseEdge
        id={id}
        path={path}
        className={`topo-edge-ink ${up ? "" : "topo-edge-down"}`}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeLinecap: "round",
          strokeOpacity: active ? 1 : up ? 0.85 : 0.7,
          strokeDasharray: up ? undefined : DOWN_DASH,
        }}
      />
      {up && flowEnabled && (
        <path
          d={path}
          fill="none"
          className="topo-edge-flow"
          stroke="var(--surface)"
          strokeWidth={Math.max(1, width * 0.55)}
          strokeLinecap="round"
          pointerEvents="none"
        />
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={`topo-edge-label absolute nodrag nopan pointer-events-none px-1.5 py-px rounded-full border bg-panel font-mono text-[9px] leading-[13px] font-semibold tabular-nums whitespace-nowrap ${
              active ? "border-accent text-accent" : up ? "border-line text-primary" : "border-line text-muted"
            }`}
            data-link-status={status}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(AggregatedEdge);
