// ── React Flow type aliases ──────────────────────────────────────────────────
// Central node/edge typings for the topology canvas. xyflow v12 wants data
// types with implicit index signatures, hence `type` aliases over interfaces.

import type { Node, Edge } from "@xyflow/react";
import type { TopologyNode, RackInfo } from "../../types";

export type RackNodeData = {
  rack: RackInfo;
  devices: TopologyNode[];
  classColors: string[];
  activePorts: number;
  totalPorts: number;
};
export type RackFlowNode = Node<RackNodeData, "rack">;

export type DeviceNodeData = {
  device: TopologyNode;
  classColor: string | null;
  inRack: boolean;
};
export type DeviceFlowNode = Node<DeviceNodeData, "device">;

export type BackgroundNodeData = {
  url: string;
  opacity: number;
  color: string;
};
export type BackgroundFlowNode = Node<BackgroundNodeData, "mapBackground">;

export type TopoFlowNode = RackFlowNode | DeviceFlowNode | BackgroundFlowNode;

export type AggregatedEdgeData = {
  label: string;
  color: string;
  width: number;
  active: boolean;
};
export type AggregatedFlowEdge = Edge<AggregatedEdgeData, "aggregated">;
