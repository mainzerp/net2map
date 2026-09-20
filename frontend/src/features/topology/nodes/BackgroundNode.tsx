import type { NodeProps } from "@xyflow/react";
import type { BackgroundFlowNode } from "../flowTypes";

// ── BackgroundNode ───────────────────────────────────────────────────────────
// The user-uploaded map background (floor plan, photo) rendered as a regular
// canvas node so it pans/zooms with the viewport. Sits below all other nodes
// (negative zIndex) and is not interactive.

export default function BackgroundNode({ data }: NodeProps<BackgroundFlowNode>) {
  return (
    <div className="w-full h-full relative overflow-hidden rounded-2xl">
      <img
        src={data.url}
        alt=""
        draggable={false}
        className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundColor: data.color, opacity: 1 - data.opacity }}
      />
    </div>
  );
}
