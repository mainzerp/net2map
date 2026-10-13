import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { Ban } from "lucide-react";
import { getBorderAnchor, nodeCenter } from "./floating";
import { useFlowEnabled } from "../flowContext";
import type { AggregatedFlowEdge, TopoFlowNode } from "../flowTypes";
import { LATENCY_EDGE_COLOR, type LatencyEdgeTone } from "../../latency/latency";

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

//
// Logical layers (data.overlay, see overlays.ts) recolor instead of adding
// paths: emphasized edges use the layer color (the selected VLAN's own color
// from overlay.color, falling back to --overlay-vlan; --overlay-stp) one step
// heavier, faded edges drop to FADED_OPACITY (still hoverable),
// STP blocked-only edges are dashed in --danger with a "blocked" pill, and a
// VLAN carried untagged only gets a small "U" chip in the label pill. An STP
// root-path edge gets an arrowhead at the end facing the root bridge. The
// selected/active edge keeps the terracotta accent in every layer. With a
// layer active the flow animation only runs on emphasized edges. The latency
// layer tints edges in the status token of the worst endpoint (success /
// warning / danger) and shows the worst endpoint RTT instead of the speed.

const DOWN_DASH = "4 4";
const BLOCKED_DASH = "5 4";
// Cross-floor edges to portal nodes are always dashed.
const PORTAL_DASH = "6 5";
const FADED_OPACITY = 0.25;

// Static class strings so Tailwind picks them up.
const LATENCY_LABEL_BORDER: Record<LatencyEdgeTone, string> = {
  success: "border-success",
  warning: "border-warning",
  danger: "border-danger",
};

function markerId(edgeId: string): string {
  return `topo-root-arrow-${edgeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

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
  const overlay = data?.overlay;
  const emphasized = overlay?.emphasis === "emphasized";
  const blockedOnly = overlay?.emphasis === "blocked";
  const faded = overlay?.emphasis === "faded" && !active;
  const isVlan = overlay?.layer === "vlan";
  const latencyTone = overlay?.layer === "latency" ? overlay.latencyTone ?? null : null;
  const vlanStroke = overlay?.color?.stroke ?? "var(--overlay-vlan)";
  const vlanSoft = overlay?.color?.soft ?? "var(--overlay-vlan-soft)";
  const overlayColor = latencyTone ? LATENCY_EDGE_COLOR[latencyTone] : isVlan ? vlanStroke : "var(--overlay-stp)";
  const baseWidth = data?.width || 1.5;
  const width = baseWidth + (active || emphasized || blockedOnly ? 1 : 0);
  const color = active
    ? "var(--accent)"
    : blockedOnly
      ? "var(--danger)"
      : emphasized
        ? overlayColor
        : up ? data?.color || "var(--line-strong)" : "var(--muted)";
  const dash = blockedOnly ? BLOCKED_DASH : data?.portal ? PORTAL_DASH : up ? undefined : DOWN_DASH;
  const inkOpacity = faded ? FADED_OPACITY : active || emphasized || blockedOnly ? 1 : up ? 0.85 : 0.7;
  const showFlow = up && flowEnabled && (!overlay || emphasized);
  const rootEnd = emphasized && overlay?.layer === "stp" ? overlay.rootEnd ?? null : null;
  const arrowId = rootEnd ? markerId(id) : null;
  const blockedCount = overlay?.layer === "stp" ? overlay.blockedCount ?? 0 : 0;
  const untagged = emphasized && overlay?.layer === "vlan" && !!overlay.untagged;
  const blockedText = blockedOnly ? "blocked" : blockedCount > 0 ? `${blockedCount} blocked` : null;
  const labelText = latencyTone && overlay?.latencyLabel ? overlay.latencyLabel : data?.label;
  const hasLabel = !!labelText || untagged || !!blockedText;
  const labelTone = active
    ? "border-accent text-accent"
    : blockedText
      ? "border-danger text-primary"
      : emphasized
        ? `${latencyTone ? LATENCY_LABEL_BORDER[latencyTone] : isVlan ? "" : "border-overlay-stp"} text-primary`
        : up ? "border-line text-primary" : "border-line text-muted";
  // Dynamic VLAN colors cannot be Tailwind classes, so the pill border is inline.
  const labelBorderColor = !active && !blockedText && emphasized && isVlan ? vlanStroke : undefined;

  return (
    <g
      data-overlay={overlay ? overlay.emphasis : undefined}
      data-latency-tone={latencyTone ?? undefined}
      data-vlan-untagged={untagged ? "true" : undefined}
    >
      {arrowId && (
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="9"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0,1 L9,5 L0,9 z" style={{ fill: active ? "var(--accent)" : "var(--overlay-stp)" }} />
          </marker>
        </defs>
      )}
      <path
        d={path}
        fill="none"
        className="topo-edge-casing"
        stroke="var(--surface)"
        strokeWidth={width + 3}
        strokeLinecap="round"
        strokeOpacity={faded ? FADED_OPACITY : 0.9}
        pointerEvents="none"
      />
      <BaseEdge
        id={id}
        path={path}
        className={`topo-edge-ink ${up ? "" : "topo-edge-down"}`}
        markerEnd={arrowId && rootEnd === "target" ? `url(#${arrowId})` : undefined}
        markerStart={arrowId && rootEnd === "source" ? `url(#${arrowId})` : undefined}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeLinecap: "round",
          strokeOpacity: inkOpacity,
          strokeDasharray: dash,
        }}
      />
      {showFlow && (
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
      {hasLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity: faded ? FADED_OPACITY : undefined,
              borderColor: labelBorderColor,
            }}
            className={`topo-edge-label absolute nodrag nopan pointer-events-none inline-flex items-center gap-1 px-1.5 py-px rounded-full border bg-panel font-mono text-[9px] leading-[13px] font-semibold tabular-nums whitespace-nowrap ${labelTone}`}
            data-link-status={status}
          >
            {untagged && (
              <span
                className="topo-vlan-untagged rounded-sm px-[3px]"
                style={{ backgroundColor: vlanSoft, color: vlanStroke }}
                title="VLAN carried untagged (native)"
              >
                U
              </span>
            )}
            {blockedText && (
              <span className="inline-flex items-center gap-0.5 text-danger" data-testid="stp-blocked-marker">
                <Ban size={9} strokeWidth={2} aria-hidden="true" />
                {blockedText}
              </span>
            )}
            {labelText}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

export default memo(AggregatedEdge);
