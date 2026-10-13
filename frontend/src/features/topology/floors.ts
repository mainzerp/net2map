// ── Buildings and floors: pure helpers ───────────────────────────────────────
// Floor resolution for the topology map. A device's EFFECTIVE floor is its
// rack's floor when it is racked, else its own floor_id. Exactly one floor is
// active on the map at a time; the pseudo floor "unassigned" collects racks
// and devices without an effective floor. When no floors exist at all the map
// is unscoped (active key null) and behaves as before.

import type { Building, Floor, RackInfo, SwitchClass, TopologyNode } from "../../types";

export const UNASSIGNED = "unassigned" as const;
export type FloorKey = number | typeof UNASSIGNED;

export const FLOOR_PARAM = "floor";

export interface FloorEntry {
  floor: Floor;
  building: Building;
}

// Floor membership predicates handed to the graph builders.
export interface FloorScope {
  active: FloorKey;
  deviceFloor: (node: TopologyNode) => number | null;
  rackFloor: (rack: RackInfo) => number | null;
}

export function floorKeyOf(floorId: number | null | undefined): FloorKey {
  return floorId == null ? UNASSIGNED : floorId;
}

export function parseFloorKey(raw: string | null | undefined): FloorKey | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === UNASSIGNED) return UNASSIGNED;
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

export function formatFloorKey(key: FloorKey): string {
  return String(key);
}

// Flatten buildings into floors in display order (building sort_order, then
// floor sort_order; ids break ties so the order is deterministic).
export function flattenFloors(buildings: Building[] | null | undefined): FloorEntry[] {
  const byOrder = <T extends { sort_order: number; id: number }>(a: T, b: T) =>
    a.sort_order - b.sort_order || a.id - b.id;
  return [...(buildings ?? [])]
    .sort(byOrder)
    .flatMap(building => [...(building.floors ?? [])].sort(byOrder).map(floor => ({ floor, building })));
}

export function findFloor(buildings: Building[] | null | undefined, floorId: number | null | undefined): FloorEntry | null {
  if (floorId == null) return null;
  return flattenFloors(buildings).find(e => e.floor.id === floorId) ?? null;
}

// Effective floor id of a device given the racks lookup.
export function effectiveDeviceFloor(
  node: TopologyNode,
  racksById: Map<number, RackInfo>,
): number | null {
  if (node.rack_id != null) {
    const rack = racksById.get(node.rack_id);
    if (rack) return rack.floor_id ?? null;
  }
  return node.floor_id ?? null;
}

export function createFloorScope(active: FloorKey, racks: RackInfo[]): FloorScope {
  const racksById = new Map((racks || []).map(r => [r.id, r]));
  return {
    active,
    deviceFloor: node => effectiveDeviceFloor(node, racksById),
    rackFloor: rack => rack.floor_id ?? null,
  };
}

export function inFloor(floorId: number | null | undefined, active: FloorKey): boolean {
  return floorKeyOf(floorId) === active;
}

// Whether a device would appear on the map at all (ignoring floor/filters):
// racked in a managed rack, or outside and allowed by its class.
function mapVisible(
  node: TopologyNode,
  rackIds: Set<number>,
  classAllowsOutside: Record<number, boolean>,
): boolean {
  if (node.rack_id != null) return rackIds.has(node.rack_id);
  return node.class_id == null || !!classAllowsOutside[node.class_id];
}

export interface FloorSummary {
  // Map-visible device count per floor key (floor id or "unassigned").
  counts: Map<FloorKey, number>;
  unassigned: number;
}

export function summarizeFloors(
  nodes: TopologyNode[],
  racks: RackInfo[],
  classes: SwitchClass[],
): FloorSummary {
  const racksById = new Map((racks || []).map(r => [r.id, r]));
  const rackIds = new Set(racksById.keys());
  const classAllowsOutside = Object.fromEntries((classes || []).map(c => [c.id, !!c.allow_outside_rack]));
  const counts = new Map<FloorKey, number>();
  (nodes || []).forEach(node => {
    if (!mapVisible(node, rackIds, classAllowsOutside)) return;
    const key = floorKeyOf(effectiveDeviceFloor(node, racksById));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return { counts, unassigned: counts.get(UNASSIGNED) ?? 0 };
}

// Resolve the active floor: the requested key when it still exists ("unassigned"
// only while something is unassigned), else the first floor of the first
// building. Null when no floors exist (unscoped map).
export function resolveActiveFloor(
  buildings: Building[] | null | undefined,
  requested: FloorKey | null,
  unassignedAvailable: boolean,
): FloorKey | null {
  const floors = flattenFloors(buildings);
  if (floors.length === 0) return null;
  if (requested === UNASSIGNED && unassignedAvailable) return UNASSIGNED;
  if (typeof requested === "number" && floors.some(e => e.floor.id === requested)) return requested;
  return floors[0].floor.id;
}

// Short floor label for portals and badges: "<floor>", with the building
// prefix when it differs from the reference building.
export function floorDisplayLabel(
  buildings: Building[] | null | undefined,
  key: FloorKey,
  referenceBuildingId?: number | null,
): string {
  if (key === UNASSIGNED) return "Unassigned";
  const entry = findFloor(buildings, key);
  if (!entry) return "Unknown floor";
  if (referenceBuildingId != null && entry.building.id === referenceBuildingId) return entry.floor.label;
  return `${entry.building.label} / ${entry.floor.label}`;
}

export function viewportStorageKey(active: FloorKey | null): string {
  return active == null ? "net2map-zoom" : `net2map-zoom:${formatFloorKey(active)}`;
}
