// ── Rack elevation layout math (pure, unit-tested) ──────────────────────────
// U positions are 1-based and U1 sits at the BOTTOM of the rack (real-world
// convention). A device occupies the inclusive range [pos, pos + uHeight - 1].

import type { TopologyNode } from "../../types";

// Pixel height of a single rack unit row.
export const U_PX = 26;

export interface Placement {
  deviceId: number;
  pos: number; // 1-based U position of the bottom-most occupied U
  uHeight: number;
}

export interface RackLayoutEntry {
  device_id: number;
  rack_u_position: number;
  u_height: number;
}

export interface DropTarget {
  pos: number;
  row: number; // 0-based row from the top of the rack body
  valid: boolean;
}

export const DEFAULT_RACK_HEIGHT_U = 42;

export function rackHeightU(rack: { height_u?: number }): number {
  return rack.height_u ?? DEFAULT_RACK_HEIGHT_U;
}

export function deviceUHeight(device: { u_height?: number }): number {
  return Math.max(1, device.u_height ?? 1);
}

// 0-based row from the top at which a device occupying [pos, pos+uHeight-1]
// is rendered.
export function rowFromTop(heightU: number, pos: number, uHeight: number): number {
  return heightU - pos - uHeight + 1;
}

// Inverse of rowFromTop: bottom U position for a device whose top edge is at
// the given 0-based row.
export function posFromRow(heightU: number, row: number, uHeight: number): number {
  return heightU - row - uHeight + 1;
}

export function rangesOverlap(aPos: number, aHeight: number, bPos: number, bHeight: number): boolean {
  return aPos <= bPos + bHeight - 1 && bPos <= aPos + aHeight - 1;
}

// True when a device with the given extent can sit at pos: inside the rack and
// not overlapping any other placement.
export function placementValid(
  placements: Placement[],
  deviceId: number,
  pos: number,
  uHeight: number,
  heightU: number,
): boolean {
  if (!Number.isInteger(pos) || pos < 1 || pos + uHeight - 1 > heightU) return false;
  return !placements.some(
    (p) => p.deviceId !== deviceId && rangesOverlap(p.pos, p.uHeight, pos, uHeight),
  );
}

// Compute the drop target for a pointer at the given 0-based row.
export function computeDropTarget(
  placements: Placement[],
  deviceId: number,
  row: number,
  uHeight: number,
  heightU: number,
): DropTarget {
  const pos = posFromRow(heightU, row, uHeight);
  return { pos, row, valid: placementValid(placements, deviceId, pos, uHeight, heightU) };
}

// Full layout payload for PATCH /api/racks/{id}/layout.
export function buildLayoutEntries(placements: Placement[]): RackLayoutEntry[] {
  return placements
    .slice()
    .sort((a, b) => a.pos - b.pos || a.deviceId - b.deviceId)
    .map((p) => ({ device_id: p.deviceId, rack_u_position: p.pos, u_height: p.uHeight }));
}

// Placements of all devices currently positioned in the given rack.
export function placementsFromNodes(nodes: TopologyNode[], rackId: number): Placement[] {
  return nodes
    .filter((n) => n.rack_id === rackId && n.rack_u_position != null)
    .map((n) => ({ deviceId: n.id, pos: n.rack_u_position as number, uHeight: deviceUHeight(n) }));
}

// Number of rack units occupied by placed devices.
export function usedUnits(placements: Placement[]): number {
  return placements.reduce((sum, p) => sum + p.uHeight, 0);
}
