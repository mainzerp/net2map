// ── Topology graph model ─────────────────────────────────────────────────────
// Pure data transforms: turn the /api/topology payload into the rack/device
// node lists and aggregated endpoint links the React Flow canvas renders.
// Extracted from the old SVG TopologyMap so behavior (filtering, outside-node
// rules, link aggregation, rack-pair coloring) stays identical.

import type {
  TopologyNode,
  TopologyLink,
  RackInfo,
  SwitchClass,
  FilterState,
  PortInfo,
} from "../../types";
import { CABLE_COLORS, speedColor, speedLabelToMbps } from "../../theme/visual";
import { floorKeyOf, inFloor, type FloorKey, type FloorScope } from "./floors";

export interface MapRack {
  id: number;
  label: string;
  location: string;
  rack: RackInfo;
  devices: TopologyNode[];
}

// Endpoint ids follow the legacy scheme so rackPairColorMap keys stay
// compatible with RackDetail: String(rackId) or `outside:${nodeId}`.
export type EndpointId = string;

export interface AggregatedLink {
  key: string;
  from: EndpointId;
  to: EndpointId;
  individual: TopologyLink[];
  count: number;
  speed: string | undefined;
}

const SPEED_ORDER: Record<string, number> = {
  "100G": 6,
  "40G": 5,
  "25G": 4,
  "10G": 3,
  "1G": 2,
  "100M": 1,
};

// Canvas node id helpers -------------------------------------------------------

export function rackNodeId(rackId: number | string): string {
  return `rack:${rackId}`;
}

export function deviceNodeId(deviceId: number | string): string {
  return `device:${deviceId}`;
}

export function endpointToNodeId(endpoint: EndpointId): string {
  return endpoint.startsWith("outside:")
    ? deviceNodeId(endpoint.slice("outside:".length))
    : rackNodeId(endpoint);
}

// Color fallbacks --------------------------------------------------------------

export function speedFallbackColor(label: string | undefined): string {
  const mbps = speedLabelToMbps(label);
  return mbps ? speedColor(mbps) : "var(--line-strong)";
}

// Visible racks ----------------------------------------------------------------

// The optional floor scope restricts every builder to the active floor; with
// no scope (no floors defined) everything is included as before.

export function buildMapRacks(
  nodes: TopologyNode[],
  managedRacks: RackInfo[],
  filters: FilterState,
  scope?: FloorScope | null,
): MapRack[] {
  const map: Record<number, MapRack> = {};
  (managedRacks || []).forEach(r => {
    if (scope && !inFloor(scope.rackFloor(r), scope.active)) return;
    map[r.id] = {
      id: r.id,
      label: r.label,
      location: `${r.label}${r.room ? " / " + r.room : ""}`,
      rack: r,
      devices: [],
    };
  });
  nodes.forEach(node => {
    if (node.rack_id && map[node.rack_id]) {
      map[node.rack_id].devices.push(node);
    }
    // nodes without a rack assignment are not shown inside racks
  });
  let result = Object.values(map).filter(r => r.devices.length > 0);
  if (filters?.racks) {
    result = result.filter(r => filters.racks!.has(r.id));
  }
  if (filters?.classes) {
    result = result
      .map(r => ({
        ...r,
        devices: r.devices.filter(d => d.class_id && filters.classes!.has(d.class_id)),
      }))
      .filter(r => r.devices.length > 0);
  }
  return result;
}

// Outside nodes ----------------------------------------------------------------

export function computeClassAllowsOutside(
  switchClasses: SwitchClass[],
): Record<number, boolean> {
  return Object.fromEntries((switchClasses || []).map(c => [c.id, !!c.allow_outside_rack]));
}

export function buildOutsideNodes(
  nodes: TopologyNode[],
  switchClasses: SwitchClass[],
  filters: FilterState,
  scope?: FloorScope | null,
): TopologyNode[] {
  const classAllowsOutside = computeClassAllowsOutside(switchClasses);
  // Nodes without a rack are shown outside when their class allows it.
  // Nodes without any class would otherwise be invisible on the map, so
  // they are always rendered as outside nodes (fallback).
  let result = nodes.filter(
    node => node.rack_id == null && (node.class_id == null || classAllowsOutside[node.class_id]),
  );
  if (scope) {
    result = result.filter(node => inFloor(scope.deviceFloor(node), scope.active));
  }
  if (filters?.classes) {
    result = result.filter(node => node.class_id && filters.classes!.has(node.class_id));
  }
  return result;
}

// Endpoint aggregation -----------------------------------------------------------

export function buildEndpointIndex(
  nodes: TopologyNode[],
  managedRacks: RackInfo[],
  switchClasses: SwitchClass[],
  scope?: FloorScope | null,
): Record<string, EndpointId> {
  const classAllowsOutside = computeClassAllowsOutside(switchClasses);
  const rackIds = new Set((managedRacks || []).map(r => String(r.id)));
  const map: Record<string, EndpointId> = {};
  nodes.forEach(node => {
    if (scope && !inFloor(scope.deviceFloor(node), scope.active)) return;
    const rackKey = node.rack_id != null ? String(node.rack_id) : null;
    if (rackKey && rackIds.has(rackKey)) {
      map[node.ip] = rackKey;
    } else if (node.class_id == null || classAllowsOutside[node.class_id]) {
      map[node.ip] = `outside:${node.id}`;
    }
  });
  return map;
}

export function buildAggregatedLinks(
  links: TopologyLink[],
  endpointByIp: Record<string, EndpointId>,
  visibleEndpointIds: Set<EndpointId>,
): AggregatedLink[] {
  const grouped: Record<string, { key: string; from: EndpointId; to: EndpointId; individual: TopologyLink[] }> = {};
  (links || []).forEach(l => {
    const endpointA = endpointByIp[l.local_ip];
    const endpointB = endpointByIp[l.remote_ip];
    // Intra-rack links share one endpoint and are dropped on the map
    // (they are shown in the RackDetail panel instead).
    if (!endpointA || !endpointB || endpointA === endpointB) return;
    if (!visibleEndpointIds.has(endpointA) || !visibleEndpointIds.has(endpointB)) return;
    const key = [endpointA, endpointB].sort().join("|");
    if (!grouped[key]) grouped[key] = { key, from: endpointA, to: endpointB, individual: [] };
    grouped[key].individual.push(l);
  });
  return Object.values(grouped).map(finalizeAggregate);
}

function finalizeAggregate(
  g: { key: string; from: EndpointId; to: EndpointId; individual: TopologyLink[] },
): AggregatedLink {
  // Deduplicate by sorted port-pair key to avoid counting both directions
  const portSeen = new Set<string>();
  const unique: TopologyLink[] = [];
  g.individual.forEach(l => {
    const pk = [l.local_ip + ":" + l.local_port, l.remote_ip + ":" + l.remote_port].sort().join("|");
    if (!portSeen.has(pk)) {
      portSeen.add(pk);
      unique.push(l);
    }
  });
  // Pick the highest speed for the line color
  const best = unique.reduce(
    (a, b) => ((SPEED_ORDER[b.speed_label || ""] || 0) > (SPEED_ORDER[a.speed_label || ""] || 0) ? b : a),
    unique[0],
  );
  return { ...g, count: unique.length, speed: best?.speed_label };
}

// Portals (cross-floor links) -----------------------------------------------------
// A link whose one endpoint is visible on the active floor and whose other
// endpoint lives on another floor (or is unassigned) becomes a portal: one
// portal node per remote endpoint, with one aggregated edge (from = local,
// to = remote) per local endpoint it connects to.

export interface Portal {
  remote: EndpointId;
  remoteFloor: FloorKey;
  links: AggregatedLink[];
}

export function portalNodeId(remote: EndpointId): string {
  return `portal:${remote}`;
}

// Floor key of an endpoint id (rack id or `outside:<deviceId>`).
export function makeEndpointFloor(
  nodes: TopologyNode[],
  managedRacks: RackInfo[],
  scope: FloorScope,
): (endpoint: EndpointId) => FloorKey {
  const racksById = new Map((managedRacks || []).map(r => [String(r.id), r]));
  const nodesById = new Map((nodes || []).map(n => [String(n.id), n]));
  return endpoint => {
    if (endpoint.startsWith("outside:")) {
      const node = nodesById.get(endpoint.slice("outside:".length));
      return floorKeyOf(node ? scope.deviceFloor(node) : null);
    }
    const rack = racksById.get(endpoint);
    return floorKeyOf(rack ? scope.rackFloor(rack) : null);
  };
}

export function buildPortals(
  links: TopologyLink[],
  endpointByIp: Record<string, EndpointId>,
  visibleEndpointIds: Set<EndpointId>,
  endpointFloor: (endpoint: EndpointId) => FloorKey,
  active: FloorKey,
): Portal[] {
  const grouped: Record<string, { key: string; from: EndpointId; to: EndpointId; individual: TopologyLink[] }> = {};
  (links || []).forEach(l => {
    const a = endpointByIp[l.local_ip];
    const b = endpointByIp[l.remote_ip];
    if (!a || !b || a === b) return;
    const aLocal = visibleEndpointIds.has(a);
    const bLocal = visibleEndpointIds.has(b);
    if (aLocal === bLocal) return;
    const local = aLocal ? a : b;
    const remote = aLocal ? b : a;
    // Same floor but hidden by a filter: no portal (matches plain filtering).
    if (endpointFloor(remote) === active) return;
    const key = [local, remote].sort().join("|");
    if (!grouped[key]) grouped[key] = { key, from: local, to: remote, individual: [] };
    grouped[key].individual.push(l);
  });
  const byRemote = new Map<EndpointId, AggregatedLink[]>();
  Object.values(grouped).forEach(g => {
    const agg = finalizeAggregate(g);
    const list = byRemote.get(agg.to) ?? [];
    list.push(agg);
    byRemote.set(agg.to, list);
  });
  return [...byRemote.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, list]) => ({
      remote,
      remoteFloor: endpointFloor(remote),
      links: list.sort((x, y) => x.from.localeCompare(y.from)),
    }));
}

// Link status -------------------------------------------------------------------
// Links carry no state of their own; derive it from the local (or remote) port
// oper_status when the port can be matched by name, otherwise from device
// reachability. A discovered link with a known speed and no contrary evidence
// counts as up; with neither port data nor speed it is unknown.

export type LinkStatus = "up" | "down" | "unknown";

const normPortId = (s: string | undefined | null): string => (s || "").trim().toLowerCase();

// Resolve an LLDP/CDP port label to the device's PortInfo by name, port_id or
// ifDescr (case-insensitive); null when the device or port is unknown.
export function resolvePort(device: TopologyNode | undefined, port: string | null | undefined): PortInfo | null {
  if (!device) return null;
  const key = normPortId(port);
  if (!key) return null;
  return (device.ports || []).find(
    p => normPortId(p.name) === key || normPortId(p.port_id) === key || normPortId(p.if_descr) === key,
  ) ?? null;
}

function portOperStatus(device: TopologyNode | undefined, port: string): number | null {
  const match = resolvePort(device, port);
  return match ? match.oper_status : null;
}

export function linkStatus(link: TopologyLink, nodesByIp: Map<string, TopologyNode>): LinkStatus {
  const local = nodesByIp.get(link.local_ip);
  const remote = nodesByIp.get(link.remote_ip);
  const localOper = portOperStatus(local, link.local_port);
  const oper = localOper ?? portOperStatus(remote, link.remote_port);
  if (oper != null) return oper === 1 ? "up" : "down";
  if (local?.ping_status === "offline" || remote?.ping_status === "offline") return "down";
  return link.speed_label ? "up" : "unknown";
}

// Aggregate: up when any member link is up, down when all known members are
// down, unknown otherwise.
export function aggregateLinkStatus(statuses: LinkStatus[]): LinkStatus {
  if (statuses.some(s => s === "up")) return "up";
  if (statuses.length > 0 && statuses.every(s => s === "down")) return "down";
  return "unknown";
}

// Rack-pair color map (ported from MapPage; keys use the legacy endpoint ids) ---

export function buildRackPairColorMap(
  nodes: TopologyNode[],
  links: TopologyLink[],
  switchClasses: SwitchClass[],
): Record<string, string> {
  const classAllowsOutside = computeClassAllowsOutside(switchClasses);
  const ipToEndpoint: Record<string, EndpointId> = {};
  (nodes || []).forEach(n => {
    if (n.rack_id) {
      ipToEndpoint[n.ip] = String(n.rack_id);
    } else if (n.class_id == null || classAllowsOutside[n.class_id]) {
      ipToEndpoint[n.ip] = `outside:${n.id}`;
    }
  });
  const seen: Record<string, string> = {};
  let idx = 0;
  (links || []).forEach(l => {
    const a = ipToEndpoint[l.local_ip];
    const b = ipToEndpoint[l.remote_ip];
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join("|");
    if (!(key in seen)) {
      seen[key] = CABLE_COLORS[idx % CABLE_COLORS.length];
      idx++;
    }
  });
  return seen;
}

// Port counters -------------------------------------------------------------------

export function rackPortCounts(devices: TopologyNode[]): { active: number; total: number } {
  const total = devices.reduce((s, d) => s + (d.ports || []).length, 0);
  const active = devices.reduce((s, d) => s + (d.ports || []).filter(p => p.oper_status === 1).length, 0);
  return { active, total };
}
