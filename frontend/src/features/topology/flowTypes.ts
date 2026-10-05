// ── React Flow type aliases ──────────────────────────────────────────────────
// Central node/edge typings for the topology canvas. xyflow v12 wants data
// types with implicit index signatures, hence `type` aliases over interfaces.

import type { Node, Edge } from "@xyflow/react";
import type { TopologyNode, RackInfo } from "../../types";
import type { LinkStatus } from "./graph";
import type { NodeOverlay } from "./overlays";
import type { VlanColor } from "./vlanColor";

export type RackNodeData = {
  rack: RackInfo;
  devices: TopologyNode[];
  classColors: string[];
  activePorts: number;
  totalPorts: number;
  overlay?: NodeOverlay;
};
export type RackFlowNode = Node<RackNodeData, "rack">;

export type DeviceNodeData = {
  device: TopologyNode;
  classColor: string | null;
  inRack: boolean;
  overlay?: NodeOverlay;
};
export type DeviceFlowNode = Node<DeviceNodeData, "device">;

export type BackgroundNodeData = {
  url: string;
  opacity: number;
  color: string;
};
export type BackgroundFlowNode = Node<BackgroundNodeData, "mapBackground">;

export type TopoFlowNode = RackFlowNode | DeviceFlowNode | BackgroundFlowNode;

// Logical layer encoding of one aggregated edge (absent when the layer is Off).
//  - emphasis: drawn in the layer's overlay color; faded: dimmed to ~0.25
//  - untagged: VLAN carried untagged only ("U" marker)
//  - blocked: STP blocked member(s); blockedOnly draws the edge dashed
//  - rootEnd: which end of the edge the STP root lies toward (arrow marker)
//  - color: VLAN mode, the selected VLAN's color (vlanColor.ts)
export type EdgeOverlay = {
  layer: "stp" | "vlan";
  emphasis: "emphasized" | "faded" | "blocked";
  color?: VlanColor;
  untagged?: boolean;
  blockedCount?: number;
  rootEnd?: "source" | "target" | null;
};

export type AggregatedEdgeData = {
  label: string;
  color: string;
  width: number;
  active: boolean;
  status: LinkStatus;
  overlay?: EdgeOverlay;
};
export type AggregatedFlowEdge = Edge<AggregatedEdgeData, "aggregated">;
