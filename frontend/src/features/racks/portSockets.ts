// ── Faceplate port socket layout (pure, unit-tested) ────────────────────────
// Turns a device's port list into the socket arrangement drawn on its rack
// faceplate: access ports in one or two rows (odd positions on top, even
// positions on the bottom, like real switches) and uplink/SFP ports grouped at
// the right end. Devices with very many ports render a compact LED strip.

import type { PortInfo } from "../../types";

// More visible ports than this -> sockets are split into two rows.
export const TWO_ROW_THRESHOLD = 12;

// More visible ports than this -> compact LED strip instead of sockets, to cap
// the DOM cost of chassis switches and stacked members.
export const COMPACT_PORT_THRESHOLD = 96;

// Speed (Mbps) from which a port counts as an uplink.
export const UPLINK_MIN_SPEED_MBPS = 10000;

// Name hints for uplink / SFP cages. Deliberately simple and documented:
//   - "sfp" anywhere            (sfp1, SFP+ 49, 1/1/sfp2)
//   - "uplink" anywhere         (Uplink 1)
//   - "25g" anywhere            (25GigE1/0/1)
//   - "xg" or "te" as a prefix  (xg1, XGigabitEthernet0/1, Te1/0/1,
//     TenGigabitEthernet1/1) - only as a name prefix so that names such as
//     "ethernet" or "gigabitethernet" do not match.
const UPLINK_ANYWHERE = /sfp|uplink|25g/;
const UPLINK_PREFIX = /^(xg|te)/;

export function portSpeedMbps(port: PortInfo): number {
  return Number(port.speed_mbps ?? port.speed ?? 0) || 0;
}

export function isUplinkPort(port: PortInfo): boolean {
  if (portSpeedMbps(port) >= UPLINK_MIN_SPEED_MBPS) return true;
  const names = [port.name, port.if_descr, port.port_id]
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => n.trim().toLowerCase());
  return names.some((n) => UPLINK_ANYWHERE.test(n) || UPLINK_PREFIX.test(n));
}

export interface SocketGroup {
  top: PortInfo[];
  bottom: PortInfo[];
}

export interface SocketLayout {
  compact: boolean;
  twoRow: boolean;
  // Every visible port in if_index order (used by the compact strip).
  ports: PortInfo[];
  access: SocketGroup;
  uplinks: SocketGroup;
}

// Visible ports: sorted by if_index and cut at total_ports when set (the
// SwitchPanel uses the same rule to hide virtual interfaces).
export function visiblePorts(ports: PortInfo[], totalPorts?: number | null): PortInfo[] {
  const sorted = [...ports].sort((a, b) => (a.if_index || 0) - (b.if_index || 0));
  return sorted.slice(0, totalPorts || sorted.length);
}

// Split a group into rows. Positions are 1-based within the group: in two-row
// mode position 1, 3, 5, ... go on top and 2, 4, 6, ... on the bottom.
export function splitRows(ports: PortInfo[], twoRow: boolean): SocketGroup {
  if (!twoRow) return { top: ports, bottom: [] };
  const top: PortInfo[] = [];
  const bottom: PortInfo[] = [];
  ports.forEach((p, i) => (i % 2 === 0 ? top : bottom).push(p));
  return { top, bottom };
}

export function layoutPortSockets(ports: PortInfo[], totalPorts?: number | null): SocketLayout {
  const visible = visiblePorts(ports, totalPorts);
  const compact = visible.length > COMPACT_PORT_THRESHOLD;
  const twoRow = visible.length > TWO_ROW_THRESHOLD;
  const access: PortInfo[] = [];
  const uplinks: PortInfo[] = [];
  for (const p of visible) (isUplinkPort(p) ? uplinks : access).push(p);
  // A device made only of "uplinks" (e.g. an all-10G aggregation switch) is
  // drawn as one regular block instead of an empty access block.
  const allUplinks = access.length === 0;
  return {
    compact,
    twoRow,
    ports: visible,
    access: splitRows(allUplinks ? uplinks : access, twoRow),
    uplinks: splitRows(allUplinks ? [] : uplinks, twoRow),
  };
}

export function portLabel(port: PortInfo): string {
  return String(port.if_descr || port.name || port.port_id || port.if_index || "port");
}

export function portStatus(port: PortInfo): "up" | "down" {
  return port.oper_status === 1 ? "up" : "down";
}

function speedText(mbps: number): string {
  if (mbps <= 0) return "speed unknown";
  return mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
}

// Tooltip text for a socket: name, status, speed, VLAN and endpoint count.
export function portTitle(port: PortInfo): string {
  const parts = [portLabel(port), portStatus(port), speedText(portSpeedMbps(port))];
  parts.push(port.vlan != null && port.vlan > 0 ? `VLAN ${port.vlan}` : "no VLAN");
  const n = Number(port.endpoint_count || 0);
  parts.push(`${n} endpoint${n === 1 ? "" : "s"}`);
  return parts.join(" - ");
}

// Deterministic pseudo-random activity timing per port so the optional LED
// blink does not pulse in lockstep. Returns seconds.
export function activityTiming(seed: number, index: number): { delay: number; duration: number } {
  let h = (seed * 2654435761 + index * 40503) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0; // keep unsigned so delay/duration stay >= 0
  const delay = (h % 4000) / 1000; // 0 .. 4 s
  const duration = 3 + ((h >>> 12) % 2000) / 1000; // 3 .. 5 s
  return { delay, duration };
}
