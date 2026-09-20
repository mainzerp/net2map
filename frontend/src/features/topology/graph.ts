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
} from "../../types";
import { CABLE_COLORS, speedColor } from "../../theme/visual";

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

const SPEED_LABEL_MBPS: Record<string, number> = {
  "100G": 100000,
  "40G": 40000,
  "25G": 25000,
  "10G": 10000,
  "1G": 1000,
  "100M": 100,
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
  const mbps = SPEED_LABEL_MBPS[label || ""] || 0;
  return mbps ? speedColor(mbps) : "var(--line-strong)";
}

// Visible racks ----------------------------------------------------------------

export function buildMapRacks(
  nodes: TopologyNode[],
  managedRacks: RackInfo[],
  filters: FilterState,
): MapRack[] {
  const map: Record<number, MapRack> = {};
  (managedRacks || []).forEach(r => {
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
): TopologyNode[] {
  const classAllowsOutside = computeClassAllowsOutside(switchClasses);
  // Nodes without a rack are shown outside when their class allows it.
  // Nodes without any class would otherwise be invisible on the map, so
  // they are always rendered as outside nodes (fallback).
  let result = nodes.filter(
    node => node.rack_id == null && (node.class_id == null || classAllowsOutside[node.class_id]),
  );
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
): Record<string, EndpointId> {
  const classAllowsOutside = computeClassAllowsOutside(switchClasses);
  const rackIds = new Set((managedRacks || []).map(r => String(r.id)));
  const map: Record<string, EndpointId> = {};
  nodes.forEach(node => {
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
  return Object.values(grouped).map(g => {
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
  });
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
