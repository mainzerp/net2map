// ── TopologyCanvas ───────────────────────────────────────────────────────────
// React Flow (@xyflow/react) rebuild of the topology map. Racks render as
// collapsed boxes (click opens the RackDetail panel), unracked devices as
// standalone device nodes, and rack-pair links as aggregated floating edges.
// Position conventions:
//  - devices keep the legacy CENTER convention for map_x/map_y,
//  - racks store TOP-LEFT (new; rack positions were never persisted before).
// Positions round-trip through PATCH /api/topology/{devices,racks}/<id>/position.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStore,
  useNodesInitialized,
  type NodeTypes,
  type EdgeTypes,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type {
  TopologyNode,
  TopologyLink,
  RackInfo,
  SwitchClass,
  FilterState,
} from "../../types";
import { useTheme } from "../../theme/ThemeProvider";
import { speedLabelToMbps, speedStrokeWidth } from "../../theme/visual";
import useNetmapStore from "../../store";
import RackNode from "./nodes/RackNode";
import DeviceNode from "./nodes/DeviceNode";
import BackgroundNode from "./nodes/BackgroundNode";
import AggregatedEdge from "./edges/AggregatedEdge";
import MapToolbar from "./MapToolbar";
import {
  buildMapRacks,
  buildOutsideNodes,
  buildEndpointIndex,
  buildAggregatedLinks,
  rackPortCounts,
  endpointToNodeId,
  rackNodeId,
  deviceNodeId,
  speedFallbackColor,
  linkStatus,
  aggregateLinkStatus,
} from "./graph";
import { ZoomTierContext, ScanPulseContext, zoomTier } from "./zoomTier";
import {
  FlowEnabledContext,
  defaultFlowEnabled,
  loadFlowPreference,
  saveFlowPreference,
} from "./flowContext";
import ScanOverlay from "./ScanOverlay";
import MapLayerLegend from "./MapLayerLegend";
import {
  collectVlanOptions,
  defaultVlan,
  hasStpData,
  stpDomainCount,
  classifyAggregatedVlan,
  classifyAggregatedStp,
  nodeOverlay,
  type MapLayer,
} from "./overlays";
import { vlanColor } from "./vlanColor";
import {
  loadLayerPreference,
  saveLayerPreference,
  loadLayerVlan,
  saveLayerVlan,
} from "./layerPreference";
import { prefersReducedMotion, useReducedMotion } from "./motion";
import {
  RACK_COLLAPSED_SIZE,
  DEVICE_NODE_SIZE,
  dagreLayout,
  offsetLayout,
  isUnpositioned,
} from "./layout";
import type { TopoFlowNode, AggregatedFlowEdge, EdgeOverlay } from "./flowTypes";

const nodeTypes = { rack: RackNode, device: DeviceNode, mapBackground: BackgroundNode } as unknown as NodeTypes;
const edgeTypes = { aggregated: AggregatedEdge } as unknown as EdgeTypes;

const VIEWPORT_STORAGE_KEY = "netmap-zoom";

// Background image base box (matches the legacy 900x550 map coordinate space).
const BG_BASE = { width: 900, height: 550 };

export interface AutoLayoutAssignment {
  // rack id -> top-left position; device id -> center position (legacy convention)
  racks: Record<number, { x: number; y: number }>;
  devices: Record<number, { x: number; y: number }>;
}

export interface DevicePositionPatch {
  id: number;
  x: number;
  y: number;
}

interface TopologyCanvasProps {
  nodes: TopologyNode[];
  links: TopologyLink[];
  managedRacks: RackInfo[];
  switchClasses: SwitchClass[];
  filters: FilterState;
  onFilterChange: (updater: FilterState | ((prev: FilterState) => FilterState)) => void;
  selectedRackId: number | undefined;
  selectedOutsideId: number | null;
  onSelectRack: (rack: { id: number; label: string; location: string }) => void;
  onSelectOutside: (node: TopologyNode) => void;
  // Called when a device node (not a rack) is clicked; opens the inspector.
  // React Flow suppresses node clicks after a drag (nodeClickDistance = 0).
  onOpenDevice?: (deviceId: number) => void;
  onSearchSelect: (device: TopologyNode) => void;
  onRackPositionChange: (rackId: number, pos: { x: number; y: number }, devicePositions: DevicePositionPatch[]) => void;
  onDevicePositionChange: (deviceId: number, pos: { x: number; y: number }) => void;
  onAutoLayout: (assignment: AutoLayoutAssignment) => void;
  selectedLink: TopologyLink | null;
  rackPairColorMap: Record<string, string>;
  mapBgUrl: string | null;
  mapBgOpacity: number;
  mapBgScale: number;
  mapBgColor: string;
  stats: { switches: number; fast: number; gig: number };
  updatedAt: number | null;
  // Scan sweep overlay: shown while a scan job is running. progress is the
  // scanned fraction (0..1) or null while the total is not yet known.
  scan?: { active: boolean; progress: number | null; label?: string };
  // IPs touched by the running scan very recently (brief accent ring).
  scanPulseIps?: string[];
}

// Zoom the "Show on map" focus lands on: close tier for devices (port strip
// visible), mid tier for racks.
const FOCUS_DEVICE_ZOOM = 1.3;
const FOCUS_RACK_ZOOM = 1.0;

const EMPTY_IPS: string[] = [];

function loadStoredViewport(): Viewport | null {
  try {
    const raw = localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Current xyflow format
    if (typeof parsed.x === "number" && typeof parsed.y === "number" && typeof parsed.zoom === "number") {
      return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
    }
    // Legacy SVG map format {scale, tx, ty}
    if (typeof parsed.scale === "number" && typeof parsed.tx === "number" && typeof parsed.ty === "number") {
      return { x: parsed.tx, y: parsed.ty, zoom: parsed.scale };
    }
  } catch { /* ignore */ }
  return null;
}

function deviceTopLeft(node: TopologyNode): { x: number; y: number } {
  return { x: node.map_x - DEVICE_NODE_SIZE.width / 2, y: node.map_y - DEVICE_NODE_SIZE.height / 2 };
}

function deviceCenter(topLeft: { x: number; y: number }): { x: number; y: number } {
  return { x: topLeft.x + DEVICE_NODE_SIZE.width / 2, y: topLeft.y + DEVICE_NODE_SIZE.height / 2 };
}

function rackCenter(topLeft: { x: number; y: number }): { x: number; y: number } {
  return { x: topLeft.x + RACK_COLLAPSED_SIZE.width / 2, y: topLeft.y + RACK_COLLAPSED_SIZE.height / 2 };
}

function TopologyCanvasInner(props: TopologyCanvasProps) {
  const {
    nodes, links, managedRacks, switchClasses, filters, onFilterChange,
    selectedRackId, selectedOutsideId,
    onSelectRack, onSelectOutside, onOpenDevice, onSearchSelect,
    onRackPositionChange, onDevicePositionChange, onAutoLayout,
    selectedLink, rackPairColorMap,
    mapBgUrl, mapBgOpacity, mapBgScale, mapBgColor,
    stats, updatedAt, scan, scanPulseIps = EMPTY_IPS,
  } = props;

  const rf = useReactFlow();
  const { theme } = useTheme();
  // One coarse zoom tier; the selector only re-renders on tier changes.
  const tier = useStore(s => zoomTier(s.transform[2]));
  const nodesInitialized = useNodesInitialized();
  const reducedMotion = useReducedMotion();
  const focusDeviceId = useNetmapStore(s => s.focusDeviceId);
  const clearFocusDevice = useNetmapStore(s => s.clearFocusDevice);
  const [flowPref, setFlowPref] = useState<boolean | null>(loadFlowPreference);
  const [layerPref, setLayerPref] = useState<MapLayer>(loadLayerPreference);
  const [vlanPref, setVlanPref] = useState<number | null>(loadLayerVlan);
  const pulseSet = useMemo(() => new Set(scanPulseIps), [scanPulseIps]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<TopoFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AggregatedFlowEdge>([]);
  const [initialViewport] = useState<Viewport | null>(loadStoredViewport);
  // Node ids whose dragged position was sent to the backend but may not be
  // reflected in the polled topology yet; the rebuild keeps their canvas
  // position until the server catches up.
  const pendingPositionRef = useRef<Set<string>>(new Set());

  const classMap = useMemo(
    () => Object.fromEntries((switchClasses || []).map(c => [c.id, c])),
    [switchClasses],
  );

  const racks = useMemo(() => buildMapRacks(nodes, managedRacks, filters), [nodes, managedRacks, filters]);
  const outsideNodes = useMemo(
    () => buildOutsideNodes(nodes, switchClasses, filters),
    [nodes, switchClasses, filters],
  );

  // Resolve node positions: stored coordinates where available, dagre for
  // everything unpositioned.
  const graphModel = useMemo(() => {
    interface TopNode { id: string; width: number; height: number; x: number; y: number }
    const positioned: TopNode[] = [];
    const pending: TopNode[] = [];

    racks.forEach(rack => {
      const size = RACK_COLLAPSED_SIZE;
      const id = rackNodeId(rack.id);
      const rx = rack.rack.map_x;
      const ry = rack.rack.map_y;
      if (!isUnpositioned(rx, ry)) {
        positioned.push({ id, ...size, x: rx as number, y: ry as number });
        return;
      }
      // Legacy fallback: racks never had positions; derive from the centroid
      // of member devices that do have stored (center-convention) positions.
      const placed = rack.devices.filter(d => !isUnpositioned(d.map_x, d.map_y));
      if (placed.length > 0) {
        const cx = placed.reduce((s, d) => s + d.map_x, 0) / placed.length;
        const cy = placed.reduce((s, d) => s + d.map_y, 0) / placed.length;
        positioned.push({ id, ...size, x: cx - size.width / 2, y: cy - size.height / 2 });
        return;
      }
      pending.push({ id, ...size, x: 0, y: 0 });
    });

    outsideNodes.forEach(node => {
      const id = deviceNodeId(node.id);
      if (!isUnpositioned(node.map_x, node.map_y)) {
        const tl = deviceTopLeft(node);
        positioned.push({ id, ...DEVICE_NODE_SIZE, x: tl.x, y: tl.y });
      } else {
        pending.push({ id, ...DEVICE_NODE_SIZE, x: 0, y: 0 });
      }
    });

    // Partial dagre: lay out only unpositioned nodes, anchored beside the
    // bounding box of the positioned ones.
    if (pending.length > 0) {
      const endpointByIp = buildEndpointIndex(nodes, managedRacks, switchClasses);
      const pendingEdges = (links || [])
        .map(l => {
          const a = endpointByIp[l.local_ip];
          const b = endpointByIp[l.remote_ip];
          if (!a || !b || a === b) return null;
          return { source: endpointToNodeId(a), target: endpointToNodeId(b) };
        })
        .filter((e): e is { source: string; target: string } => e !== null);
      const laid = dagreLayout(pending, pendingEdges);
      let anchor = { x: 80, y: 80 };
      if (positioned.length > 0) {
        anchor = {
          x: Math.max(...positioned.map(p => p.x + p.width)) + 240,
          y: Math.min(...positioned.map(p => p.y)),
        };
      }
      const shifted = offsetLayout(laid, pending, anchor);
      shifted.forEach((pos, id) => {
        const n = pending.find(p => p.id === id);
        if (n) positioned.push({ ...n, x: pos.x, y: pos.y });
      });
    }

    const byId = new Map(positioned.map(p => [p.id, p]));
    return { positions: byId };
  }, [racks, outsideNodes, nodes, managedRacks, switchClasses, links]);

  // Aggregated inter-endpoint links for the canvas.
  const aggregated = useMemo(() => {
    const endpointByIp = buildEndpointIndex(nodes, managedRacks, switchClasses);
    const visible = new Set<string>();
    racks.forEach(r => visible.add(String(r.id)));
    outsideNodes.forEach(n => visible.add(`outside:${n.id}`));
    return buildAggregatedLinks(links, endpointByIp, visible);
  }, [nodes, managedRacks, switchClasses, racks, outsideNodes, links]);

  const nodesByIp = useMemo(() => new Map(nodes.map(n => [n.ip, n])), [nodes]);

  // Logical layer: the stored preference falls back to Off while the data
  // for it is missing (the preference itself is kept).
  const stpAvailable = useMemo(() => hasStpData(nodes), [nodes]);
  const vlanOptions = useMemo(() => collectVlanOptions(nodes), [nodes]);
  const vlanAvailable = vlanOptions.length > 0;
  const stpDomains = useMemo(() => stpDomainCount(nodes), [nodes]);
  const layer: MapLayer =
    (layerPref === "stp" && !stpAvailable) || (layerPref === "vlan" && !vlanAvailable) ? "off" : layerPref;
  const selectedVlan =
    vlanPref != null && vlanOptions.some(o => o.id === vlanPref) ? vlanPref : defaultVlan(vlanOptions);
  const selectedVlanLabel = vlanOptions.find(o => o.id === selectedVlan)?.label ?? null;

  // Per-edge layer encoding keyed by endpoint pair.
  const edgeOverlays = useMemo(() => {
    const result = new Map<string, EdgeOverlay>();
    if (layer === "off") return result;
    const endpointByIp = buildEndpointIndex(nodes, managedRacks, switchClasses);
    const color = selectedVlan == null ? undefined : vlanColor(selectedVlan);
    aggregated.forEach(l => {
      const pairKey = [l.from, l.to].sort().join("|");
      if (layer === "vlan") {
        if (selectedVlan == null) return;
        const carry = classifyAggregatedVlan(l, nodesByIp, selectedVlan);
        result.set(pairKey, {
          layer: "vlan",
          emphasis: carry === "none" ? "faded" : "emphasized",
          color,
          untagged: carry === "untagged",
        });
        return;
      }
      const stp = classifyAggregatedStp(l, nodesByIp, endpointByIp);
      result.set(pairKey, {
        layer: "stp",
        emphasis: stp.state === "root" ? "emphasized" : stp.state === "blocked" ? "blocked" : "faded",
        blockedCount: stp.blockedCount,
        rootEnd: stp.towardRoot == null ? null : stp.towardRoot === l.to ? "target" : stp.towardRoot === l.from ? "source" : null,
      });
    });
    return result;
  }, [layer, selectedVlan, aggregated, nodes, nodesByIp, managedRacks, switchClasses]);

  // Which endpoint pair contains the link selected in RackDetail.
  const activePairKey = useMemo(() => {
    if (!selectedLink) return null;
    const endpointByIp = buildEndpointIndex(nodes, managedRacks, switchClasses);
    const a = endpointByIp[selectedLink.local_ip];
    const b = endpointByIp[selectedLink.remote_ip];
    if (!a || !b || a === b) return null;
    return [a, b].sort().join("|");
  }, [selectedLink, nodes, managedRacks, switchClasses]);

  // Rebuild flow nodes/edges whenever the model changes. Selection flags are
  // carried over from the previous node state.
  useEffect(() => {
    // Collected inside the updater, applied afterwards so the updater itself
    // stays free of side effects (it can be double-invoked under StrictMode).
    const caughtUp: string[] = [];
    setFlowNodes(prev => {
      const prevById = new Map(prev.map(n => [n.id, n]));
      const prevSelected = new Set(prev.filter(n => n.selected).map(n => n.id));
      const pending = pendingPositionRef.current;
      const next: TopoFlowNode[] = [];

      // A rebuild must not fight an in-progress drag or an in-flight position
      // PATCH: keep the canvas position while the node is dragging, and while
      // it is pending keep it until the server reports the same position
      // (meaning the PATCH landed). A PATCH that failed leaves the marker
      // set, so the node never snaps back to stale server coordinates.
      const resolvePosition = (id: string, serverPos: { x: number; y: number }): { x: number; y: number } => {
        const p = prevById.get(id);
        if (!p) return serverPos;
        if (p.dragging) return p.position;
        if (pending.has(id)) {
          if (Math.abs(serverPos.x - p.position.x) <= 1 && Math.abs(serverPos.y - p.position.y) <= 1) {
            caughtUp.push(id);
          } else {
            return p.position;
          }
        }
        return serverPos;
      };

      if (mapBgUrl) {
        next.push({
          id: "__mapbg",
          type: "mapBackground",
          position: { x: 0, y: 0 },
          data: { url: mapBgUrl, opacity: mapBgOpacity, color: mapBgColor },
          style: { width: BG_BASE.width * mapBgScale, height: BG_BASE.height * mapBgScale, zIndex: -10 },
          draggable: false,
          selectable: false,
          deletable: false,
        });
      }

      racks.forEach(rack => {
        const id = rackNodeId(rack.id);
        const pos = resolvePosition(id, graphModel.positions.get(id) || { x: 100, y: 100 });
        const counts = rackPortCounts(rack.devices);
        const classIds = [...new Set(rack.devices.map(d => d.class_id).filter(Boolean))] as number[];
        const classColors = classIds.map(cid => classMap[cid]?.color).filter(Boolean) as string[];
        next.push({
          id,
          type: "rack",
          position: { x: pos.x, y: pos.y },
          data: {
            rack: rack.rack,
            devices: rack.devices,
            classColors,
            activePorts: counts.active,
            totalPorts: counts.total,
            overlay: layer === "off" ? undefined : nodeOverlay(rack.devices, layer, selectedVlan),
          },
          style: { width: RACK_COLLAPSED_SIZE.width, height: RACK_COLLAPSED_SIZE.height, zIndex: 0 },
          selected: prevSelected.has(id),
          deletable: false,
        });
      });

      outsideNodes.forEach(node => {
        const id = deviceNodeId(node.id);
        const pos = resolvePosition(id, graphModel.positions.get(id) || { x: 100, y: 100 });
        next.push({
          id,
          type: "device",
          position: { x: pos.x, y: pos.y },
          data: {
            device: node,
            classColor: node.class_id ? classMap[node.class_id]?.color || null : null,
            inRack: false,
            overlay: layer === "off" ? undefined : nodeOverlay([node], layer, selectedVlan),
          },
          style: { width: DEVICE_NODE_SIZE.width, height: DEVICE_NODE_SIZE.height },
          selected: prevSelected.has(id),
          deletable: false,
        });
      });

      return next;
    });
    // Drop pending markers for nodes whose PATCHed position has landed.
    caughtUp.forEach(id => pendingPositionRef.current.delete(id));

    setEdges(
      aggregated.map(l => {
        const pairKey = [l.from, l.to].sort().join("|");
        const color = rackPairColorMap[pairKey] || speedFallbackColor(l.speed);
        // Ink weight encodes the best member speed; the count is in the label.
        const width = speedStrokeWidth(speedLabelToMbps(l.speed));
        const status = aggregateLinkStatus(l.individual.map(link => linkStatus(link, nodesByIp)));
        return {
          id: `agg:${pairKey}`,
          source: endpointToNodeId(l.from),
          target: endpointToNodeId(l.to),
          type: "aggregated",
          data: {
            label: l.count > 1 ? `${l.count}x ${l.speed || ""}`.trim() : l.speed || "",
            color,
            width,
            active: activePairKey === pairKey,
            status,
            overlay: edgeOverlays.get(pairKey),
          },
          selectable: false,
          deletable: false,
        };
      }),
    );
  }, [graphModel, aggregated, activePairKey, racks, outsideNodes, classMap, rackPairColorMap, nodesByIp, edgeOverlays, layer, selectedVlan, mapBgUrl, mapBgOpacity, mapBgScale, mapBgColor, setFlowNodes, setEdges]);

  // Center the viewport on a rack/outside node when its selection changes
  // (covers rack clicks, toolbar search and the highlightPortKey deep-link).
  const lastCenteredRef = useRef<string | null>(null);
  useEffect(() => {
    const key = selectedRackId != null
      ? rackNodeId(selectedRackId)
      : selectedOutsideId != null
        ? deviceNodeId(selectedOutsideId)
        : null;
    if (!key) {
      lastCenteredRef.current = null;
      return;
    }
    if (lastCenteredRef.current === key) return;
    const node = flowNodes.find(n => n.id === key);
    if (!node) return; // retry after the next rebuild
    const w = node.measured?.width ?? (node.style?.width as number) ?? RACK_COLLAPSED_SIZE.width;
    const h = node.measured?.height ?? (node.style?.height as number) ?? RACK_COLLAPSED_SIZE.height;
    void rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      zoom: rf.getZoom(),
      duration: prefersReducedMotion() ? 0 : 300,
    });
    lastCenteredRef.current = key;
  }, [selectedRackId, selectedOutsideId, flowNodes, rf]);

  // "Show on map" / toolbar search: center and zoom on the focused device, or
  // on its rack node when the device is racked. Declared after the selection
  // effect so its viewport call wins when both fire in the same commit. Waits
  // for topology data and measured nodes, then clears the focus; a device that
  // is not on the canvas (filtered out, ignored) just clears it.
  useEffect(() => {
    if (focusDeviceId == null) return;
    if (nodes.length === 0) return; // topology not loaded yet
    const device = nodes.find(n => n.id === focusDeviceId);
    if (!device) {
      clearFocusDevice();
      return;
    }
    const rackTarget = device.rack_id != null ? rackNodeId(device.rack_id) : null;
    const target =
      (rackTarget && flowNodes.find(n => n.id === rackTarget)) ||
      flowNodes.find(n => n.id === deviceNodeId(device.id));
    if (!target) {
      // Rebuild still pending -> retry; built but absent -> give up.
      if (flowNodes.some(n => n.type !== "mapBackground")) clearFocusDevice();
      return;
    }
    if (!nodesInitialized) return;
    const isRack = target.type === "rack";
    const fallback = isRack ? RACK_COLLAPSED_SIZE : DEVICE_NODE_SIZE;
    const w = target.measured?.width ?? (target.style?.width as number) ?? fallback.width;
    const h = target.measured?.height ?? (target.style?.height as number) ?? fallback.height;
    const zoom = Math.max(rf.getZoom(), isRack ? FOCUS_RACK_ZOOM : FOCUS_DEVICE_ZOOM);
    // Skip the selection effect's own centering for this node afterwards.
    lastCenteredRef.current = target.id;
    // Deferred one frame so it lands after xyflow's own initial fitView. Not
    // cancelled on the re-render caused by clearFocusDevice() below.
    const cx = target.position.x + w / 2;
    const cy = target.position.y + h / 2;
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      void rf.setCenter(cx, cy, { zoom, duration: prefersReducedMotion() ? 0 : 400 });
    });
    clearFocusDevice();
  }, [focusDeviceId, nodes, flowNodes, nodesInitialized, rf, clearFocusDevice]);

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: TopoFlowNode) => {
      // Mark the node so the next poll-driven rebuild does not snap it back
      // before the position PATCH is persisted.
      if (node.type === "rack" || node.type === "device") {
        pendingPositionRef.current.add(node.id);
      }
      if (node.type === "rack") {
        const rack = racks.find(r => rackNodeId(r.id) === node.id);
        if (!rack) return;
        // Persist the rack position plus the rack center (center convention)
        // for every member device so both contracts round-trip.
        const center = rackCenter(node.position);
        const devicePositions: DevicePositionPatch[] = rack.devices.map(d => ({
          id: d.id,
          x: Math.round(center.x),
          y: Math.round(center.y),
        }));
        onRackPositionChange(rack.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }, devicePositions);
        return;
      }
      if (node.type === "device") {
        const deviceId = Number(node.id.slice("device:".length));
        const center = deviceCenter(node.position);
        onDevicePositionChange(deviceId, { x: Math.round(center.x), y: Math.round(center.y) });
      }
    },
    [racks, onRackPositionChange, onDevicePositionChange],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: TopoFlowNode) => {
      if (node.type === "rack") {
        const rack = racks.find(r => rackNodeId(r.id) === node.id);
        if (rack) onSelectRack({ id: rack.id, label: rack.label, location: rack.location });
        return;
      }
      if (node.type === "device") {
        const deviceId = Number(node.id.slice("device:".length));
        const device = nodes.find(n => n.id === deviceId);
        // The inspector drawer and the inline side panel share the right edge,
        // so a device click opens only one of them.
        if (device) {
          if (onOpenDevice) onOpenDevice(device.id);
          else onSelectOutside(device);
        }
      }
    },
    [racks, nodes, onSelectRack, onSelectOutside, onOpenDevice],
  );

  const handleAutoLayout = useCallback(() => {
    const topLevel = flowNodes.filter(n => n.type !== "mapBackground");
    const laid = dagreLayout(
      topLevel.map(n => ({
        id: n.id,
        width: (n.style?.width as number) ?? RACK_COLLAPSED_SIZE.width,
        height: (n.style?.height as number) ?? RACK_COLLAPSED_SIZE.height,
      })),
      aggregated.map(l => ({ source: endpointToNodeId(l.from), target: endpointToNodeId(l.to) })),
    );

    const assignment: AutoLayoutAssignment = { racks: {}, devices: {} };
    setFlowNodes(nds =>
      nds.map(n => {
        const pos = laid.get(n.id);
        if (!pos) return n;
        return { ...n, position: pos };
      }),
    );

    laid.forEach((pos, id) => {
      // Same protection as manual drags: auto-layout PATCHes are in flight.
      pendingPositionRef.current.add(id);
      if (id.startsWith("rack:")) {
        const rackId = Number(id.slice("rack:".length));
        assignment.racks[rackId] = { x: Math.round(pos.x), y: Math.round(pos.y) };
        const rack = racks.find(r => r.id === rackId);
        const center = rackCenter(pos);
        rack?.devices.forEach(d => {
          assignment.devices[d.id] = { x: Math.round(center.x), y: Math.round(center.y) };
        });
      } else if (id.startsWith("device:")) {
        const deviceId = Number(id.slice("device:".length));
        const center = deviceCenter(pos);
        assignment.devices[deviceId] = { x: Math.round(center.x), y: Math.round(center.y) };
      }
    });

    onAutoLayout(assignment);
    requestAnimationFrame(() => {
      void rf.fitView({ duration: prefersReducedMotion() ? 0 : 300, padding: 0.15 });
    });
  }, [flowNodes, aggregated, racks, onAutoLayout, rf, setFlowNodes]);

  const handleResetZoom = useCallback(() => {
    void rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: prefersReducedMotion() ? 0 : 300 });
  }, [rf]);

  // Flow overlay: explicit preference, else on for maps up to ~300 links.
  // Under prefers-reduced-motion the overlay is never mounted.
  const flowSetting = defaultFlowEnabled(flowPref, edges.length);
  const flowActive = flowSetting && !reducedMotion;
  const handleToggleFlow = useCallback(() => {
    const next = !flowSetting;
    setFlowPref(next);
    saveFlowPreference(next);
  }, [flowSetting]);

  const handleLayerChange = useCallback((next: MapLayer) => {
    setLayerPref(next);
    saveLayerPreference(next);
  }, []);
  const handleVlanChange = useCallback((vlan: number) => {
    setVlanPref(vlan);
    saveLayerVlan(vlan);
  }, []);

  const handleMoveEnd = useCallback((_e: unknown, viewport: Viewport) => {
    try {
      localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewport));
    } catch { /* ignore */ }
  }, []);

  const minimapNodeColor = useCallback(
    (node: TopoFlowNode) =>
      node.type === "rack" ? "var(--accent)" : node.type === "mapBackground" ? "var(--line)" : "var(--muted)",
    [],
  );

  return (
    <div className="flex flex-col w-full h-full">
      <MapToolbar
        devices={nodes}
        racks={managedRacks}
        classes={switchClasses}
        filters={filters}
        onFilterChange={onFilterChange}
        onSearchSelect={onSearchSelect}
        onAutoLayout={mapBgUrl ? undefined : handleAutoLayout}
        onResetZoom={handleResetZoom}
        flowEnabled={flowSetting}
        flowDisabledReason={reducedMotion ? "Animation is off because the system requests reduced motion" : undefined}
        onToggleFlow={handleToggleFlow}
        layer={layer}
        onLayerChange={handleLayerChange}
        stpDisabledReason={stpAvailable ? undefined : "No spanning tree data reported by any device"}
        vlanDisabledReason={vlanAvailable ? undefined : "No VLAN data reported on any port"}
        vlanOptions={vlanOptions}
        selectedVlan={selectedVlan}
        onVlanChange={handleVlanChange}
        stats={stats}
        updatedAt={updatedAt}
      />
      <div
        className="topo-canvas relative flex-1 min-h-0"
        style={{ background: mapBgColor || "var(--surface)" }}
        data-zoom-tier={tier}
        data-flow={flowActive ? "on" : "off"}
        data-layer={layer}
      >
        <ZoomTierContext.Provider value={tier}>
        <FlowEnabledContext.Provider value={flowActive}>
        <ScanPulseContext.Provider value={pulseSet}>
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onMoveEnd={handleMoveEnd}
          defaultViewport={initialViewport ?? undefined}
          fitView={!initialViewport}
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.15}
          maxZoom={6}
          nodesConnectable={false}
          deleteKeyCode={null}
          colorMode={theme}
        >
          {!mapBgUrl && (
            <>
              {/* Paper grid: faint minor ruling plus a sparser major grid,
                  like surveyor's paper. Both layers are transparent so the
                  wrapper surface shows through (see .react-flow in index.css). */}
              <Background
                id="paper-minor"
                variant={BackgroundVariant.Lines}
                gap={40}
                lineWidth={0.5}
                color="var(--line)"
              />
              <Background
                id="paper-major"
                variant={BackgroundVariant.Lines}
                gap={200}
                lineWidth={1}
                color="var(--line)"
              />
            </>
          )}
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={2}
            bgColor="var(--panel)"
          />
        </ReactFlow>
        </ScanPulseContext.Provider>
        </FlowEnabledContext.Provider>
        </ZoomTierContext.Provider>
        <MapLayerLegend layer={layer} vlanId={selectedVlan} vlanLabel={selectedVlanLabel} stpDomains={stpDomains} />
        {scan?.active && <ScanOverlay progress={scan.progress} label={scan.label} />}
      </div>
    </div>
  );
}

export default function TopologyCanvas(props: TopologyCanvasProps) {
  return (
    <ReactFlowProvider>
      <TopologyCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
