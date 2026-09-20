// ── Floating edge anchors ────────────────────────────────────────────────────
// Instead of attaching every edge at a fixed handle, each edge endpoint is
// anchored at the point where the center-to-center line between the two
// connected nodes crosses the node's border. The anchor therefore follows the
// peer and updates live while a node is dragged.

import { Position, type InternalNode, type XYPosition } from "@xyflow/react";
import { RACK_COLLAPSED_SIZE, DEVICE_NODE_SIZE } from "../layout";
import type { TopoFlowNode } from "../flowTypes";

export interface BorderAnchor {
  x: number;
  y: number;
  position: Position;
}

function nodeDimensions(node: InternalNode<TopoFlowNode>): { width: number; height: number } {
  const fallback = node.type === "rack" ? RACK_COLLAPSED_SIZE : DEVICE_NODE_SIZE;
  return {
    width: node.measured?.width ?? fallback.width,
    height: node.measured?.height ?? fallback.height,
  };
}

export function nodeCenter(node: InternalNode<TopoFlowNode>): XYPosition {
  const { width, height } = nodeDimensions(node);
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
  };
}

// Intersection of the ray from the node's center toward `toward` with the
// node's rectangular bounds, plus the matching handle side.
export function getBorderAnchor(node: InternalNode<TopoFlowNode>, toward: XYPosition): BorderAnchor {
  const { width, height } = nodeDimensions(node);
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;

  if (dx === 0 && dy === 0) {
    return { x: center.x, y: center.y, position: Position.Right };
  }

  // Smallest scale factor at which the ray leaves the rectangle: the ray hits
  // a vertical border at halfW/|dx| and a horizontal one at halfH/|dy|.
  const scaleX = dx !== 0 ? width / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? height / 2 / Math.abs(dy) : Infinity;

  if (scaleX <= scaleY) {
    return {
      x: center.x + dx * scaleX,
      y: center.y + dy * scaleX,
      position: dx > 0 ? Position.Right : Position.Left,
    };
  }
  return {
    x: center.x + dx * scaleY,
    y: center.y + dy * scaleY,
    position: dy > 0 ? Position.Bottom : Position.Top,
  };
}
