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

// A U range occupied by something other than a device (a rack item such as a
// patch panel). Devices can never be dropped onto it.
export interface UBlock {
  pos: number;
  uHeight: number;
}

// True when a device with the given extent can sit at pos: inside the rack and
// not overlapping any other placement or blocked range.
export function placementValid(
  placements: Placement[],
  deviceId: number,
  pos: number,
  uHeight: number,
  heightU: number,
  blocked: UBlock[] = [],
): boolean {
  if (!Number.isInteger(pos) || pos < 1 || pos + uHeight - 1 > heightU) return false;
  if (blocked.some((b) => rangesOverlap(b.pos, b.uHeight, pos, uHeight))) return false;
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
  blocked: UBlock[] = [],
): DropTarget {
  const pos = posFromRow(heightU, row, uHeight);
  return { pos, row, valid: placementValid(placements, deviceId, pos, uHeight, heightU, blocked) };
}

// U ranges occupied by rack items, as blocked ranges for device placement.
// Items that do not fit inside the rack are dropped like stale device rows.
export function itemBlocks(
  items: { id?: number; rack_u_position: number; u_height: number }[],
  heightU: number,
): (UBlock & { id?: number })[] {
  return items
    .map((i) => ({ id: i.id, pos: i.rack_u_position, uHeight: Math.max(1, i.u_height) }))
    .filter((b) => b.pos >= 1 && b.pos + b.uHeight - 1 <= heightU);
}

// Validation message for placing a rack item at [pos, pos + uHeight - 1], or
// null when the range is free. Mirrors the backend checks: inside the rack and
// no overlap with placed devices or other items (excludeItemId = item being edited).
export function itemPlacementError(
  pos: number,
  uHeight: number,
  heightU: number,
  placements: Placement[],
  items: { id: number; rack_u_position: number; u_height: number }[],
  excludeItemId: number | null = null,
): string | null {
  if (!Number.isInteger(pos) || !Number.isInteger(uHeight) || pos < 1 || uHeight < 1) {
    return "U position and height must be positive whole numbers";
  }
  if (pos + uHeight - 1 > heightU) {
    return `U${pos}-U${pos + uHeight - 1} does not fit in a ${heightU}U rack`;
  }
  if (placements.some((p) => rangesOverlap(p.pos, p.uHeight, pos, uHeight))) {
    return "Overlaps a placed device";
  }
  if (items.some((i) => i.id !== excludeItemId && rangesOverlap(i.rack_u_position, i.u_height, pos, uHeight))) {
    return "Overlaps another rack item";
  }
  return null;
}

// Full layout payload for PATCH /api/racks/{id}/layout.
export function buildLayoutEntries(placements: Placement[]): RackLayoutEntry[] {
  return placements
    .slice()
    .sort((a, b) => a.pos - b.pos || a.deviceId - b.deviceId)
    .map((p) => ({ device_id: p.deviceId, rack_u_position: p.pos, u_height: p.uHeight }));
}

// Placements of all devices currently positioned in the given rack.
// Defensive clamping for out-of-range data (the backend now validates
// u_height and rack_u_position as 1..48, but stale rows may exist):
// u_height is clamped to the rack height and placements that still cannot
// fit inside the rack are dropped so no faceplate renders outside the frame.
export function placementsFromNodes(nodes: TopologyNode[], rackId: number, heightU: number): Placement[] {
  const h = Math.max(1, heightU);
  return nodes
    .filter((n) => n.rack_id === rackId && n.rack_u_position != null)
    .map((n) => ({
      deviceId: n.id,
      pos: n.rack_u_position as number,
      uHeight: Math.min(deviceUHeight(n), h),
    }))
    .filter((p) => p.pos >= 1 && p.pos + p.uHeight - 1 <= h);
}

// Number of rack units occupied by placed devices and blocked ranges.
export function usedUnits(placements: Placement[], blocked: UBlock[] = []): number {
  return (
    placements.reduce((sum, p) => sum + p.uHeight, 0) + blocked.reduce((sum, b) => sum + b.uHeight, 0)
  );
}

// Click-vs-drag threshold for faceplates and tray items: a press whose pointer
// travelled less than this distance (in CSS pixels) between pointerdown and
// pointerup counts as a click (opens the inspector), not as a drag.
export const CLICK_MOVE_THRESHOLD_PX = 4;

export function isClickGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  threshold: number = CLICK_MOVE_THRESHOLD_PX,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) < threshold;
}
