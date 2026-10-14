// ── Rack elevation layout math (pure, unit-tested) ──────────────────────────
// U positions are 1-based and U1 sits at the BOTTOM of the rack (real-world
// convention). A device occupies the inclusive range [pos, pos + uHeight - 1].
// Sides: every object is mounted on one rack face ("front" or "rear", default
// front). A full-depth object blocks its U range on BOTH faces. Two objects
// conflict iff their U ranges overlap AND their occupied face sets intersect;
// footprintsConflict is the single shared implementation of that rule.

import type { RackSide, TopologyNode } from "../../types";

// Pixel height of a single rack unit row.
export const U_PX = 26;

export const RACK_SIDES: RackSide[] = ["front", "rear"];

// Where an object sits: U range plus face. Missing side / fullDepth mean the
// API defaults ("front", false).
export interface Footprint {
  pos: number;
  uHeight: number;
  side?: RackSide;
  fullDepth?: boolean;
}

// Side and depth of a footprint that is about to be placed.
export interface SideOptions {
  side?: RackSide;
  fullDepth?: boolean;
}

export interface Placement extends Footprint {
  deviceId: number;
}

export interface RackLayoutEntry {
  device_id: number;
  rack_u_position: number;
  u_height: number;
  rack_side: RackSide;
  full_depth: boolean;
}

export interface DropTarget {
  pos: number;
  row: number; // 0-based row from the top of the rack body
  side: RackSide;
  valid: boolean;
}

export const DEFAULT_RACK_HEIGHT_U = 42;

export function rackHeightU(rack: { height_u?: number }): number {
  return rack.height_u ?? DEFAULT_RACK_HEIGHT_U;
}

export function deviceUHeight(device: { u_height?: number }): number {
  return Math.max(1, device.u_height ?? 1);
}

// Normalized face of an API object (missing or unknown values = "front").
export function sideOf(obj: { rack_side?: unknown }): RackSide {
  return obj.rack_side === "rear" ? "rear" : "front";
}

export function fullDepthOf(obj: { full_depth?: unknown }): boolean {
  return obj.full_depth === true;
}

export function oppositeSide(side: RackSide): RackSide {
  return side === "front" ? "rear" : "front";
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

// Faces occupied by a footprint: both for full depth, else its own side.
export function occupiedSides(f: SideOptions): RackSide[] {
  return f.fullDepth ? RACK_SIDES : [f.side ?? "front"];
}

// True when the footprint blocks the given face.
export function occupiesSide(f: SideOptions, side: RackSide): boolean {
  return occupiedSides(f).includes(side);
}

// The occupancy rule: U ranges overlap AND occupied face sets intersect.
export function footprintsConflict(a: Footprint, b: Footprint): boolean {
  if (!rangesOverlap(a.pos, a.uHeight, b.pos, b.uHeight)) return false;
  const bSides = occupiedSides(b);
  return occupiedSides(a).some((s) => bSides.includes(s));
}

// A U range occupied by something other than a device (a rack item such as a
// patch panel). Devices can never be dropped onto it when the faces collide.
export type UBlock = Footprint;

// True when a device with the given extent can sit at pos on the given side:
// inside the rack and not conflicting with any other placement or blocked
// range. Default side is front, not full depth.
export function placementValid(
  placements: Placement[],
  deviceId: number,
  pos: number,
  uHeight: number,
  heightU: number,
  blocked: UBlock[] = [],
  options: SideOptions = {},
): boolean {
  if (!Number.isInteger(pos) || pos < 1 || pos + uHeight - 1 > heightU) return false;
  const candidate: Footprint = { pos, uHeight, side: options.side ?? "front", fullDepth: options.fullDepth ?? false };
  if (blocked.some((b) => footprintsConflict(b, candidate))) return false;
  return !placements.some((p) => p.deviceId !== deviceId && footprintsConflict(p, candidate));
}

// Compute the drop target for a pointer at the given 0-based row of the
// given side's rack body.
export function computeDropTarget(
  placements: Placement[],
  deviceId: number,
  row: number,
  uHeight: number,
  heightU: number,
  blocked: UBlock[] = [],
  options: SideOptions = {},
): DropTarget {
  const pos = posFromRow(heightU, row, uHeight);
  const side = options.side ?? "front";
  return {
    pos,
    row,
    side,
    valid: placementValid(placements, deviceId, pos, uHeight, heightU, blocked, { ...options, side }),
  };
}

type ItemLike = { id?: number; rack_u_position: number; u_height: number; rack_side?: RackSide; full_depth?: boolean };

// U ranges occupied by rack items, as blocked ranges for device placement.
// Items that do not fit inside the rack are dropped like stale device rows.
export function itemBlocks(items: ItemLike[], heightU: number): (UBlock & { id?: number })[] {
  return items
    .map((i) => ({
      id: i.id,
      pos: i.rack_u_position,
      uHeight: Math.max(1, i.u_height),
      side: sideOf(i),
      fullDepth: fullDepthOf(i),
    }))
    .filter((b) => b.pos >= 1 && b.pos + b.uHeight - 1 <= heightU);
}

// Validation message for placing a rack item at [pos, pos + uHeight - 1] on
// the given side, or null when the range is free. Mirrors the backend checks:
// inside the rack and no conflict with placed devices or other items
// (excludeItemId = item being edited).
export function itemPlacementError(
  pos: number,
  uHeight: number,
  heightU: number,
  placements: Placement[],
  items: (ItemLike & { id: number })[],
  excludeItemId: number | null = null,
  options: SideOptions = {},
): string | null {
  if (!Number.isInteger(pos) || !Number.isInteger(uHeight) || pos < 1 || uHeight < 1) {
    return "U position and height must be positive whole numbers";
  }
  if (pos + uHeight - 1 > heightU) {
    return `U${pos}-U${pos + uHeight - 1} does not fit in a ${heightU}U rack`;
  }
  const candidate: Footprint = { pos, uHeight, side: options.side ?? "front", fullDepth: options.fullDepth ?? false };
  if (placements.some((p) => footprintsConflict(p, candidate))) {
    return "Overlaps a placed device";
  }
  if (
    items.some(
      (i) =>
        i.id !== excludeItemId &&
        footprintsConflict(
          { pos: i.rack_u_position, uHeight: Math.max(1, i.u_height), side: sideOf(i), fullDepth: fullDepthOf(i) },
          candidate,
        ),
    )
  ) {
    return "Overlaps another rack item";
  }
  return null;
}

// Full layout payload for PATCH /api/racks/{id}/layout.
export function buildLayoutEntries(placements: Placement[]): RackLayoutEntry[] {
  return placements
    .slice()
    .sort((a, b) => a.pos - b.pos || a.deviceId - b.deviceId)
    .map((p) => ({
      device_id: p.deviceId,
      rack_u_position: p.pos,
      u_height: p.uHeight,
      rack_side: p.side ?? "front",
      full_depth: p.fullDepth ?? false,
    }));
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
      side: sideOf(n),
      fullDepth: fullDepthOf(n),
    }))
    .filter((p) => p.pos >= 1 && p.pos + p.uHeight - 1 <= h);
}

// Number of rack units occupied by placed devices and blocked ranges. With a
// side, only footprints that block that face are counted (full-depth objects
// count on both faces).
export function usedUnits(placements: Footprint[], blocked: Footprint[] = [], side?: RackSide): number {
  const all = [...placements, ...blocked].filter((f) => side == null || occupiesSide(f, side));
  return all.reduce((sum, f) => sum + f.uHeight, 0);
}

// Topmost free slot of the given height on the given side, or 1 when the
// rack is full (default U position for new rack items).
export function topmostFreeU(
  heightU: number,
  occupied: Footprint[],
  options: SideOptions = {},
  uHeight = 1,
): number {
  const side = options.side ?? "front";
  const fullDepth = options.fullDepth ?? false;
  for (let u = heightU - uHeight + 1; u >= 1; u--) {
    if (!occupied.some((o) => footprintsConflict(o, { pos: u, uHeight, side, fullDepth }))) return u;
  }
  return 1;
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
