// ── Logical topology overlays ────────────────────────────────────────────────
// Pure classification for the map's logical layers (STP and VLAN). Nothing in
// here touches React; TopologyCanvas memoizes the results and hands them to
// the edges/nodes as plain data.
//
// VLAN: a link carries VLAN X when a resolved endpoint port has X as its
// untagged/native VLAN (`vlan`) or in `tagged_vlans`. Any resolved end is
// enough (lenient on purpose: some vendors report an empty tagged list for
// "allow all" trunks on one side). Tagged on any end wins over untagged.
//
// STP: a link is on the root path when a resolved endpoint port has the root
// role; it is blocked when an endpoint port has the blocked role or a
// blocking/broken state. Blocked wins over root for a single link.

import type { DeviceStpInfo, LatencyDevice, LatencyStatus, PortInfo, TopologyLink, TopologyNode } from "../../types";
import { formatMs, latencyEdgeTone, worstStatus, type LatencyEdgeTone } from "../latency/latency";
import { resolvePort, type AggregatedLink, type EndpointId } from "./graph";
import { vlanColor, type VlanColor } from "./vlanColor";

export type MapLayer = "off" | "stp" | "vlan" | "latency";

// VLAN options ---------------------------------------------------------------

export interface VlanOption {
  id: number;
  name: string | null;
  label: string;
  // Number of ports (across all devices) that are members of this VLAN.
  portCount: number;
}

function portVlans(port: PortInfo): number[] {
  const ids: number[] = [];
  if (typeof port.vlan === "number") ids.push(port.vlan);
  (port.tagged_vlans || []).forEach(v => {
    if (typeof v === "number" && !ids.includes(v)) ids.push(v);
  });
  return ids;
}

export function hasStpData(nodes: TopologyNode[]): boolean {
  return nodes.some(n => n.stp != null);
}

// All VLAN ids found on ports, sorted numerically. The label reads "20 · Clients"
// when any device names the VLAN (first non-empty name in node order wins).
export function collectVlanOptions(nodes: TopologyNode[]): VlanOption[] {
  const counts = new Map<number, number>();
  nodes.forEach(n => {
    (n.ports || []).forEach(p => {
      portVlans(p).forEach(v => counts.set(v, (counts.get(v) ?? 0) + 1));
    });
  });
  const names = new Map<number, string>();
  nodes.forEach(n => {
    Object.entries(n.vlan_names || {}).forEach(([key, value]) => {
      const id = Number(key);
      const name = typeof value === "string" ? value.trim() : "";
      if (!Number.isFinite(id) || !name || names.has(id)) return;
      names.set(id, name);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, portCount]) => {
      const name = names.get(id) ?? null;
      return { id, name, label: name ? `${id} · ${name}` : String(id), portCount };
    });
}

// Most common VLAN other than 1, else 1, else the first option (null if none).
export function defaultVlan(options: VlanOption[]): number | null {
  const candidates = options.filter(o => o.id !== 1);
  if (candidates.length > 0) {
    return candidates.reduce((best, o) => (o.portCount > best.portCount ? o : best), candidates[0]).id;
  }
  return options.length > 0 ? options[0].id : null;
}

// VLAN classification ---------------------------------------------------------

export type VlanCarry = "tagged" | "untagged" | "none";

function portCarry(port: PortInfo | null, vlan: number): VlanCarry | null {
  if (!port) return null;
  if ((port.tagged_vlans || []).includes(vlan)) return "tagged";
  if (port.vlan === vlan) return "untagged";
  return "none";
}

export function classifyLinkVlan(
  link: TopologyLink,
  nodesByIp: Map<string, TopologyNode>,
  vlan: number,
): VlanCarry {
  const local = portCarry(resolvePort(nodesByIp.get(link.local_ip), link.local_port), vlan);
  const remote = portCarry(resolvePort(nodesByIp.get(link.remote_ip), link.remote_port), vlan);
  if (local === "tagged" || remote === "tagged") return "tagged";
  if (local === "untagged" || remote === "untagged") return "untagged";
  return "none";
}

// Aggregated edge: tagged if any member link is tagged, untagged if any member
// carries the VLAN untagged only, otherwise none.
export function classifyAggregatedVlan(
  agg: Pick<AggregatedLink, "individual">,
  nodesByIp: Map<string, TopologyNode>,
  vlan: number,
): VlanCarry {
  let result: VlanCarry = "none";
  for (const link of agg.individual) {
    const c = classifyLinkVlan(link, nodesByIp, vlan);
    if (c === "tagged") return "tagged";
    if (c === "untagged") result = "untagged";
  }
  return result;
}

// Ports of a device that are members (tagged or untagged) of the VLAN.
export function deviceVlanPortCount(device: TopologyNode, vlan: number): number {
  return (device.ports || []).filter(p => p.vlan === vlan || (p.tagged_vlans || []).includes(vlan)).length;
}

// STP classification ------------------------------------------------------------

export type StpLinkState = "root" | "blocked" | "forwarding" | "unknown";

export interface StpLinkClass {
  state: StpLinkState;
  // IP of the device the root lies toward (root links only).
  towardRootIp: string | null;
  // IP of the device whose port is blocked (blocked links only).
  blockedIp: string | null;
}

export function isPortBlocked(port: PortInfo | null): boolean {
  if (!port) return false;
  return port.stp_role === "blocked" || port.stp_state === "blocking" || port.stp_state === "broken";
}

function hasStpPortData(port: PortInfo | null): boolean {
  return !!port && (port.stp_role != null || port.stp_state != null);
}

export function classifyLinkStp(link: TopologyLink, nodesByIp: Map<string, TopologyNode>): StpLinkClass {
  const local = resolvePort(nodesByIp.get(link.local_ip), link.local_port);
  const remote = resolvePort(nodesByIp.get(link.remote_ip), link.remote_port);
  if (isPortBlocked(local) || isPortBlocked(remote)) {
    return { state: "blocked", towardRootIp: null, blockedIp: isPortBlocked(local) ? link.local_ip : link.remote_ip };
  }
  // The root port of a bridge faces the root, so the root lies on the far side.
  if (local?.stp_role === "root") return { state: "root", towardRootIp: link.remote_ip, blockedIp: null };
  if (remote?.stp_role === "root") return { state: "root", towardRootIp: link.local_ip, blockedIp: null };
  if (hasStpPortData(local) || hasStpPortData(remote)) return { state: "forwarding", towardRootIp: null, blockedIp: null };
  return { state: "unknown", towardRootIp: null, blockedIp: null };
}

export interface StpEdgeClass {
  // root: at least one member is on the root path; blocked: no root member
  // but at least one blocked member; forwarding/unknown otherwise.
  state: StpLinkState;
  rootCount: number;
  blockedCount: number;
  // Endpoint the root lies toward, from the first root member.
  towardRoot: EndpointId | null;
  // Endpoint holding the blocked port, from the first blocked member.
  blockedEnd: EndpointId | null;
}

export function classifyAggregatedStp(
  agg: Pick<AggregatedLink, "individual">,
  nodesByIp: Map<string, TopologyNode>,
  endpointByIp: Record<string, EndpointId>,
): StpEdgeClass {
  let rootCount = 0;
  let blockedCount = 0;
  let forwarding = false;
  let towardRoot: EndpointId | null = null;
  let blockedEnd: EndpointId | null = null;
  agg.individual.forEach(link => {
    const c = classifyLinkStp(link, nodesByIp);
    if (c.state === "root") {
      rootCount++;
      if (towardRoot == null && c.towardRootIp) towardRoot = endpointByIp[c.towardRootIp] ?? null;
    } else if (c.state === "blocked") {
      blockedCount++;
      if (blockedEnd == null && c.blockedIp) blockedEnd = endpointByIp[c.blockedIp] ?? null;
    } else if (c.state === "forwarding") {
      forwarding = true;
    }
  });
  const state: StpLinkState = rootCount > 0 ? "root" : blockedCount > 0 ? "blocked" : forwarding ? "forwarding" : "unknown";
  return { state, rootCount, blockedCount, towardRoot, blockedEnd };
}

// Distinct root bridge ids among devices with STP data (STP domains or
// per-VLAN instances reporting different roots).
export function stpDomainCount(nodes: TopologyNode[]): number {
  const roots = new Set<string>();
  nodes.forEach(n => {
    const id = n.stp?.root_id;
    if (id) roots.add(id.trim().toLowerCase());
  });
  return roots.size;
}

export type StpProtocol = DeviceStpInfo["protocol"];

const STP_PROTOCOL_ORDER: StpProtocol[] = ["mstp", "rstp", "stp", "unknown"];

// Display name of a spanning tree protocol ("RSTP", "Unknown").
export function stpProtocolName(protocol: StpProtocol): string {
  return protocol === "unknown" ? "Unknown" : protocol.toUpperCase();
}

export interface StpProtocolCount {
  protocol: StpProtocol;
  count: number;
}

// Devices per spanning tree protocol (MSTP, RSTP, STP, unknown order); a mix
// of known protocols marks region or interoperability boundaries.
export function stpProtocolCounts(nodes: TopologyNode[]): StpProtocolCount[] {
  const counts = new Map<StpProtocol, number>();
  nodes.forEach(n => {
    if (n.stp) counts.set(n.stp.protocol, (counts.get(n.stp.protocol) ?? 0) + 1);
  });
  return STP_PROTOCOL_ORDER.filter(p => counts.has(p)).map(p => ({ protocol: p, count: counts.get(p) ?? 0 }));
}

// Known protocols of the given devices as one label ("RSTP", "MSTP/RSTP");
// null when none of them reports a known protocol.
function stpProtocolLabel(devices: TopologyNode[]): string | null {
  const known = new Set<StpProtocol | undefined>(devices.map(d => d.stp?.protocol));
  known.delete("unknown");
  const label = STP_PROTOCOL_ORDER.filter(p => known.has(p)).map(stpProtocolName).join("/");
  return label || null;
}

// Latency classification --------------------------------------------------------
// An aggregated edge takes the worst monitor status of the devices at the ends
// of its member links, and the highest RTT among them for the label.

export interface LatencyEdgeClass {
  status: LatencyStatus;
  rttMs: number | null;
  tone: LatencyEdgeTone | null;
  label: string | null;
}

export function classifyAggregatedLatency(
  agg: Pick<AggregatedLink, "individual">,
  nodesByIp: Map<string, TopologyNode>,
  latencyById: Map<number, LatencyDevice>,
): LatencyEdgeClass {
  let status: LatencyStatus = "unknown";
  let rttMs: number | null = null;
  const seen = new Set<number>();
  for (const link of agg.individual) {
    for (const ip of [link.local_ip, link.remote_ip]) {
      const node = nodesByIp.get(ip);
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      const entry = latencyById.get(node.id);
      if (!entry) continue;
      status = worstStatus(status, entry.status);
      if (entry.rtt_ms != null && (rttMs == null || entry.rtt_ms > rttMs)) rttMs = entry.rtt_ms;
    }
  }
  return { status, rttMs, tone: latencyEdgeTone(status), label: rttMs != null ? formatMs(rttMs) : null };
}

// Node overlay -------------------------------------------------------------------

export type NodeDim = "none" | "faded" | "strong";

export interface NodeOverlay {
  dim: NodeDim;
  // VLAN mode: member ports in the selected VLAN (summed over a rack's devices).
  vlanPorts: number | null;
  // STP mode: the node is (or contains) the root bridge.
  isRoot: boolean;
  // STP mode: protocol label of the node's devices ("RSTP", "MSTP/RSTP").
  stpProtocol?: string | null;
  // VLAN mode: color of the selected VLAN for the port-count badge.
  color?: VlanColor;
}

export const NEUTRAL_NODE_OVERLAY: NodeOverlay = { dim: "none", vlanPorts: null, isRoot: false };

// Overlay for a canvas node representing one device or a rack of devices.
export function nodeOverlay(devices: TopologyNode[], layer: MapLayer, vlan: number | null): NodeOverlay {
  if (layer === "vlan" && vlan != null) {
    const count = devices.reduce((s, d) => s + deviceVlanPortCount(d, vlan), 0);
    return { dim: count > 0 ? "none" : "faded", vlanPorts: count, isRoot: false, color: vlanColor(vlan) };
  }
  if (layer === "stp") {
    const withStp = devices.filter(d => d.stp != null);
    if (withStp.length === 0) return { dim: "strong", vlanPorts: null, isRoot: false };
    return {
      dim: "none",
      vlanPorts: null,
      isRoot: withStp.some(d => d.stp?.is_root),
      stpProtocol: stpProtocolLabel(withStp),
    };
  }
  return NEUTRAL_NODE_OVERLAY;
}
